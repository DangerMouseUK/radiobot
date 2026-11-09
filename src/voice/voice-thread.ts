import { EventEmitter } from 'node:events';
import type { Readable } from 'node:stream';
import { type ResourceLimits, Worker } from 'node:worker_threads';
import type { DiscordGatewayAdapterCreator, DiscordGatewayAdapterImplementerMethods } from '@discordjs/voice';
import type { VoiceBasedChannel } from 'discord.js';
import { type Logger, safeErr } from '../observability/logger.ts';
import { backoffDelayMs } from '../shared/backoff.ts';
import { RadioError } from '../shared/errors.ts';
import { ownBuffer, siblingModule } from '../shared/workers.ts';
import type { PlayOptions, VoiceLink, VoiceLinkEvents, VoiceLinkFactory, VoiceLinkStats } from './link.ts';
import type { ReceiverReportReading } from './receiver-report.ts';
import {
  deserializeError,
  type FromWorker,
  type LinkSnapshot,
  type SelfTestResult,
  type ToWorker,
  type WorkerGcSummary,
  type WorkerLoopDelay,
  type WorkerTelemetry,
} from './worker/protocol.ts';

/** The parts of a `Worker` the voice thread uses; tests pass a fake over a MessageChannel. */
export interface VoiceWorkerLike {
  postMessage(msg: ToWorker, transfer?: readonly ArrayBuffer[]): void;
  on(event: 'message', listener: (msg: FromWorker) => void): unknown;
  on(event: 'error', listener: (err: Error) => void): unknown;
  on(event: 'exit', listener: (code: number) => void): unknown;
  removeAllListeners(): unknown;
  terminate(): Promise<number>;
}

/**
 * Generous for what it holds (connections, players, a few seconds of buffered audio each), so the
 * worker is never stopped for running out of heap; the young generation keeps Node's default.
 */
export const VOICE_WORKER_LIMITS: ResourceLimits = { maxOldGenerationSizeMb: 96, stackSizeMb: 4 };

export function spawnVoiceWorker(): VoiceWorkerLike {
  return new Worker(siblingModule(import.meta.url, 'worker/voice-worker'), {
    name: 'voice',
    resourceLimits: VOICE_WORKER_LIMITS,
  });
}

export interface VoiceThreadOptions {
  logger: Logger;
  spawn?: () => VoiceWorkerLike;
  /** Wait before restarting a worker that stopped, by the number of stops in a row. */
  restartDelayMs?: (attempt: number) => number;
  /** A worker that ran this long without stopping resets the restart backoff. */
  stableAfterMs?: number;
  /** How long a new worker may take to say it is ready. */
  startTimeoutMs?: number;
  /** How long a join may take (the worker's own limit; the main thread allows a little more). */
  joinTimeoutMs?: number;
  /** How long `stop()` waits for the worker to leave every channel. */
  stopTimeoutMs?: number;
  now?: () => number;
}

export interface VoiceThreadStats {
  alive: boolean;
  /** Times the worker was restarted after stopping unexpectedly. */
  restarts: number;
  /** Voice links the worker runs. */
  links: number;
  /** The worker's event-loop delay (it sends the voice packets): the minute so far and the last full one. */
  loopDelay: { current: WorkerLoopDelay | null; lastWindow: WorkerLoopDelay | null };
  /** Garbage collection in the worker's own heap, same windows. */
  gc: { current: WorkerGcSummary; lastWindow: WorkerGcSummary | null };
  heapUsedMb: number;
  heapTotalMb: number;
  externalMb: number;
  arrayBuffersMb: number;
  /** How old these figures are, ms (they arrive every few seconds). */
  ageMs: number;
}

interface PendingJoin {
  resolve: (link: WorkerVoiceLink) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

/** One worker, from spawn to exit; a restart makes a new one, and messages from an old one are ignored. */
interface Generation {
  worker: VoiceWorkerLike;
  startedAt: number;
  ready: boolean;
  dead: boolean;
  links: Map<number, WorkerVoiceLink>;
  joins: Map<number, PendingJoin>;
  adapters: Map<number, DiscordGatewayAdapterImplementerMethods>;
  onBye: (() => void) | null;
  onSelfTest: ((r: SelfTestResult) => void) | null;
  startTimer: NodeJS.Timeout | null;
}

interface ReadyWaiter {
  resolve: (gen: Generation) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

const connectFailed = () =>
  new RadioError('VOICE_CONNECT_TIMEOUT', 'Could not connect to the voice channel in time.');

/** The link's view of the voice thread. */
interface LinkChannel {
  post(msg: ToWorker, transfer?: readonly ArrayBuffer[]): void;
  forget(linkId: number): void;
  nextStreamId(): number;
}

/**
 * Runs the voice connections on a worker thread (`VOICE_THREAD=worker`). @discordjs/voice sends
 * one packet every 20 ms from a timer on whichever thread runs it; on the main thread every
 * command, database query, gateway message and garbage collection could hold that timer up. In the
 * worker it has an event loop and a heap of its own. FFmpeg, the station input and the session
 * state machine stay here; only the encoded Ogg pages cross over (one 20 ms page per packet, so about fifty a second), and the
 * worker's gateway traffic comes back through the main thread's Discord connection.
 */
export class VoiceThread {
  readonly #log: Logger;
  readonly #spawn: () => VoiceWorkerLike;
  readonly #restartDelay: (attempt: number) => number;
  readonly #stableAfterMs: number;
  readonly #startTimeoutMs: number;
  readonly #joinTimeoutMs: number;
  readonly #stopTimeoutMs: number;
  readonly #now: () => number;
  /** Each guild's gateway adapter creator, from its latest join. */
  readonly #creators = new Map<string, DiscordGatewayAdapterCreator>();
  readonly #waiters = new Set<ReadyWaiter>();
  #gen: Generation | null = null;
  #started = false;
  #stopping = false;
  #restarts = 0;
  #failures = 0;
  #restartTimer: NodeJS.Timeout | null = null;
  #gatewayReady = true;
  /** The worker's latest figures (kept across a restart, so a stopped worker's last state shows). */
  #telemetry: WorkerTelemetry | null = null;
  #telemetryAt = 0;
  #nextLinkId = 0;
  #nextStreamId = 0;

  constructor(opts: VoiceThreadOptions) {
    this.#log = opts.logger.child({ component: 'voice-thread' });
    this.#spawn = opts.spawn ?? spawnVoiceWorker;
    this.#restartDelay = opts.restartDelayMs ?? ((n) => backoffDelayMs(n, [1_000, 5_000, 15_000, 30_000]));
    this.#stableAfterMs = opts.stableAfterMs ?? 60_000;
    this.#startTimeoutMs = opts.startTimeoutMs ?? 15_000;
    this.#joinTimeoutMs = opts.joinTimeoutMs ?? 20_000;
    this.#stopTimeoutMs = opts.stopTimeoutMs ?? 2_000;
    this.#now = opts.now ?? Date.now;
  }

  /** Starts the worker and resolves once it is ready; rejects if it can't start (it keeps retrying). */
  start(): Promise<void> {
    if (this.#stopping) return Promise.reject(new Error('The voice thread has been stopped.'));
    this.#started = true;
    if (!this.#gen && !this.#restartTimer) this.#launch();
    return this.#whenReady(this.#startTimeoutMs).then(() => undefined);
  }

  get alive(): boolean {
    return this.#gen?.ready === true && !this.#gen.dead;
  }

  /** Same shape as `discordVoiceLinkFactory`: the session manager can't tell the two apart. */
  factory(): VoiceLinkFactory {
    return (channel) => this.#join(channel);
  }

  /**
   * Whether the main gateway can send right now (shard ready). The worker answers the voice
   * library's `sendPayload` from this; a payload that still fails is reported back to it.
   */
  setGatewayReady(ready: boolean): void {
    this.#gatewayReady = ready;
    const gen = this.#gen;
    if (gen && !gen.dead) this.#post(gen, { t: 'gatewayReady', ready });
  }

  stats(): VoiceThreadStats | null {
    const t = this.#telemetry;
    if (!t) return null;
    return {
      alive: this.alive,
      restarts: this.#restarts,
      links: this.#gen?.links.size ?? 0,
      loopDelay: t.loopDelay,
      gc: t.gc,
      heapUsedMb: t.heapUsedMb,
      heapTotalMb: t.heapTotalMb,
      externalMb: t.externalMb,
      arrayBuffersMb: t.arrayBuffersMb,
      ageMs: Math.max(0, this.#now() - this.#telemetryAt),
    };
  }

  /** Checks the worker can load the voice libraries and create a DAVE session (no network). */
  async selfTest(timeoutMs = 10_000): Promise<SelfTestResult> {
    const gen = await this.#whenReady(timeoutMs);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        gen.onSelfTest = null;
        reject(new Error('The voice worker did not answer its self-test in time.'));
      }, timeoutMs);
      gen.onSelfTest = (r) => {
        clearTimeout(timer);
        gen.onSelfTest = null;
        resolve(r);
      };
      this.#post(gen, { t: 'selfTest' });
    });
  }

  /**
   * Leaves every channel through the worker (its leave payloads still go out through this
   * thread's gateway), then ends the worker. Call it after the sessions have shut down and before
   * the Discord client is destroyed. Bounded by `stopTimeoutMs`.
   */
  async stop(): Promise<void> {
    if (this.#stopping) return;
    this.#stopping = true;
    if (this.#restartTimer) clearTimeout(this.#restartTimer);
    this.#restartTimer = null;
    for (const w of [...this.#waiters])
      this.#settleWaiter(w, new Error('The voice thread has been stopped.'));
    const gen = this.#gen;
    if (!gen) return;
    if (!gen.dead && gen.ready) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, this.#stopTimeoutMs);
        gen.onBye = () => {
          clearTimeout(timer);
          resolve();
        };
        this.#post(gen, { t: 'shutdown' });
      });
    }
    // It may have stopped by itself while we waited.
    if (!gen.dead) this.#retire(gen);
    await gen.worker.terminate().catch(() => 0);
  }

  // ------------------------------------------------------------------ worker lifecycle

  #launch(): void {
    let worker: VoiceWorkerLike;
    try {
      worker = this.#spawn();
    } catch (err) {
      this.#log.error({ err: safeErr(err) }, 'could not start the voice worker');
      this.#scheduleRestart();
      return;
    }
    const gen: Generation = {
      worker,
      startedAt: this.#now(),
      ready: false,
      dead: false,
      links: new Map(),
      joins: new Map(),
      adapters: new Map(),
      onBye: null,
      onSelfTest: null,
      startTimer: null,
    };
    this.#gen = gen;
    worker.on('message', (msg) => this.#onMessage(gen, msg));
    worker.on('error', (err) => this.#onStopped(gen, err));
    worker.on('exit', (code) =>
      this.#onStopped(gen, new Error(`The voice worker exited with code ${code}.`)),
    );
    gen.startTimer = setTimeout(() => {
      this.#onStopped(gen, new Error('The voice worker did not start in time.'));
    }, this.#startTimeoutMs);
    if (!this.#gatewayReady) this.#post(gen, { t: 'gatewayReady', ready: false });
  }

  #onStopped(gen: Generation, err: Error): void {
    if (gen.dead) return;
    const ranMs = this.#now() - gen.startedAt;
    const links = gen.links.size;
    this.#retire(gen);
    void gen.worker.terminate().catch(() => 0);
    if (this.#stopping) return;
    this.#log.error(
      { err: safeErr(err), links, ranMs },
      'the voice worker stopped; its voice connections are lost and will reconnect',
    );
    if (ranMs >= this.#stableAfterMs) this.#failures = 0;
    this.#scheduleRestart();
  }

  #scheduleRestart(): void {
    const wait = this.#restartDelay(this.#failures++);
    this.#restarts++;
    this.#restartTimer = setTimeout(() => {
      this.#restartTimer = null;
      this.#launch();
    }, wait);
    this.#restartTimer.unref?.();
  }

  /** Lets go of the current worker: its links are lost, its joins fail, its gateway adapters close. */
  #retire(gen: Generation): void {
    gen.dead = true;
    gen.ready = false;
    if (gen.startTimer) clearTimeout(gen.startTimer);
    gen.onBye?.();
    gen.onBye = null;
    this.#gen = null;
    for (const join of gen.joins.values()) {
      clearTimeout(join.timer);
      join.reject(connectFailed());
    }
    gen.joins.clear();
    const links = [...gen.links.values()];
    gen.links.clear();
    for (const link of links) link.workerGone();
    for (const adapter of gen.adapters.values()) {
      try {
        adapter.destroy();
      } catch (e) {
        this.#log.debug({ err: safeErr(e) }, 'gateway adapter clean-up failed');
      }
    }
    gen.adapters.clear();
  }

  #post(gen: Generation, msg: ToWorker, transfer?: readonly ArrayBuffer[]): void {
    if (gen.dead) return;
    try {
      gen.worker.postMessage(msg, transfer);
    } catch (err) {
      this.#log.debug({ err: safeErr(err), type: msg.t }, 'could not post to the voice worker');
    }
  }

  /** The ready worker, waiting up to `timeoutMs` for one (a restart may be under way). */
  #whenReady(timeoutMs: number): Promise<Generation> {
    const gen = this.#gen;
    if (gen?.ready) return Promise.resolve(gen);
    if (this.#stopping || !this.#started) {
      return Promise.reject(new Error('The voice thread is not running.'));
    }
    return new Promise((resolve, reject) => {
      const waiter: ReadyWaiter = {
        resolve,
        reject,
        timer: setTimeout(
          () => this.#settleWaiter(waiter, new Error('The voice worker is not ready.')),
          timeoutMs,
        ),
      };
      this.#waiters.add(waiter);
    });
  }

  #settleWaiter(w: ReadyWaiter, result: Generation | Error): void {
    this.#waiters.delete(w);
    clearTimeout(w.timer);
    if (result instanceof Error) w.reject(result);
    else w.resolve(result);
  }

  // ------------------------------------------------------------------ joining

  async #join(channel: VoiceBasedChannel): Promise<VoiceLink> {
    const guildId = channel.guild.id;
    this.#creators.set(guildId, channel.guild.voiceAdapterCreator);
    let gen: Generation;
    try {
      gen = await this.#whenReady(this.#joinTimeoutMs);
    } catch (err) {
      throw new RadioError('VOICE_CONNECT_TIMEOUT', 'Could not connect to the voice channel in time.', {
        cause: err,
      });
    }
    const linkId = ++this.#nextLinkId;
    return new Promise<VoiceLink>((resolve, reject) => {
      // The worker gives up after joinTimeoutMs; this only covers a worker that never answers.
      const timer = setTimeout(() => {
        gen.joins.delete(linkId);
        this.#post(gen, { t: 'destroy', linkId });
        reject(connectFailed());
      }, this.#joinTimeoutMs + 5_000);
      gen.joins.set(linkId, { resolve, reject, timer });
      this.#post(gen, {
        t: 'join',
        linkId,
        guildId,
        channelId: channel.id,
        timeoutMs: this.#joinTimeoutMs,
      });
    });
  }

  // ------------------------------------------------------------------ messages from the worker

  #onMessage(gen: Generation, msg: FromWorker): void {
    if (gen.dead) return;
    switch (msg.t) {
      case 'ready':
        this.#onReady(gen);
        return;
      case 'joined': {
        const join = gen.joins.get(msg.linkId);
        if (!join) {
          // Given up on already: let it go again.
          this.#post(gen, { t: 'destroy', linkId: msg.linkId });
          return;
        }
        gen.joins.delete(msg.linkId);
        clearTimeout(join.timer);
        const link = new WorkerVoiceLink(msg.linkId, msg.snapshot, this.#channelFor(gen));
        gen.links.set(msg.linkId, link);
        join.resolve(link);
        return;
      }
      case 'joinFailed': {
        const join = gen.joins.get(msg.linkId);
        if (!join) return;
        gen.joins.delete(msg.linkId);
        clearTimeout(join.timer);
        join.reject(deserializeError(msg.error));
        return;
      }
      case 'snapshot':
        gen.links.get(msg.linkId)?.update(msg.snapshot);
        return;
      case 'snapshots':
        for (const [linkId, snapshot] of msg.links) gen.links.get(linkId)?.update(snapshot);
        return;
      case 'lost':
      case 'audioEnded':
      case 'reconnected':
      case 'connectionError':
      case 'interrupted':
      case 'restored':
      case 'caughtUp':
      case 'flow':
      case 'report':
        gen.links.get(msg.linkId)?.receive(msg);
        return;
      case 'adapterOpen':
        this.#adapterOpen(gen, msg.adapterId, msg.guildId);
        return;
      case 'send': {
        // No adapter, or the shard can't send: what the library does with a `false` happens there.
        if (!gen.adapters.get(msg.adapterId)?.sendPayload(msg.payload)) {
          this.#post(gen, { t: 'sendFailed', adapterId: msg.adapterId });
        }
        return;
      }
      case 'adapterClose': {
        const adapter = gen.adapters.get(msg.adapterId);
        gen.adapters.delete(msg.adapterId);
        adapter?.destroy();
        return;
      }
      case 'telemetry':
        this.#onTelemetry(msg.telemetry, msg.rotated === true);
        return;
      case 'log':
        this.#log[msg.level](msg.data ?? {}, msg.msg);
        return;
      case 'selfTest':
        gen.onSelfTest?.(msg.result);
        return;
      case 'bye':
        gen.onBye?.();
        gen.onBye = null;
        return;
    }
  }

  #onReady(gen: Generation): void {
    gen.ready = true;
    if (gen.startTimer) clearTimeout(gen.startTimer);
    gen.startTimer = null;
    this.#log.info({ restarts: this.#restarts }, 'voice worker ready');
    for (const w of [...this.#waiters]) this.#settleWaiter(w, gen);
  }

  #onTelemetry(t: WorkerTelemetry, rotated: boolean): void {
    this.#telemetry = t;
    this.#telemetryAt = this.#now();
    const last = t.loopDelay.lastWindow;
    if (!rotated || !last) return;
    // The worker's loop sends the voice packets: a delay here is a late packet.
    if (last.maxMs >= 50) {
      this.#log.warn(
        { voiceLoopDelay: last, gc: t.gc.lastWindow },
        'the voice worker event loop was delayed; voice packets may have been late',
      );
    } else this.#log.debug({ voiceLoopDelay: last, gc: t.gc.lastWindow }, 'voice worker event loop delay');
  }

  /** The library opened a gateway adapter in the worker: open the real one on this thread's gateway. */
  #adapterOpen(gen: Generation, adapterId: number, guildId: string): void {
    const creator = this.#creators.get(guildId);
    if (!creator) {
      this.#post(gen, { t: 'adapterDestroy', adapterId });
      return;
    }
    const adapter = creator({
      onVoiceServerUpdate: (data) => this.#post(gen, { t: 'gateway', adapterId, kind: 'server', data }),
      onVoiceStateUpdate: (data) => this.#post(gen, { t: 'gateway', adapterId, kind: 'state', data }),
      destroy: () => this.#post(gen, { t: 'adapterDestroy', adapterId }),
    });
    gen.adapters.set(adapterId, adapter);
  }

  #channelFor(gen: Generation): LinkChannel {
    return {
      post: (msg, transfer) => this.#post(gen, msg, transfer),
      forget: (linkId) => gen.links.delete(linkId),
      nextStreamId: () => ++this.#nextStreamId,
    };
  }
}

type LinkMessage = Extract<
  FromWorker,
  {
    t:
      | 'lost'
      | 'audioEnded'
      | 'reconnected'
      | 'connectionError'
      | 'interrupted'
      | 'restored'
      | 'caughtUp'
      | 'flow'
      | 'report';
  }
>;

/** How long the stats view waits for the worker to read a receiver report. */
export const REPORT_READ_TIMEOUT_MS = 1_000;

const noop = () => {};

/**
 * The main thread's stand-in for a voice link that runs in the worker. It behaves like
 * `DiscordVoiceLink` to the session: the same events, and getters answered from the latest
 * snapshot the worker pushed (every second and on every change), the live queue's figures among
 * them. `play()` passes the encoder's Ogg pages over as they come; the live queue that keeps the
 * delay small runs in the worker, next to the player. The encoder's output is paused only if the
 * worker's buffer ever fills (a safety net: the queue reads it eagerly).
 */
export class WorkerVoiceLink extends EventEmitter<VoiceLinkEvents> implements VoiceLink {
  readonly linkId: number;
  readonly #ch: LinkChannel;
  #snap: LinkSnapshot;
  /** The stream this link is playing (0 for none). */
  #streamId = 0;
  #endedStreamId = 0;
  #hook: { streamId: number; stream: Readable; off: () => void } | null = null;
  #done = false;
  /** Receiver report reads waiting for the worker's answer (one per stats render, each with a timeout). */
  readonly #reportReads = new Map<number, (reading: ReceiverReportReading) => void>();
  #nextReportRead = 0;

  constructor(linkId: number, snapshot: LinkSnapshot, channel: LinkChannel) {
    super();
    this.linkId = linkId;
    this.#snap = snapshot;
    this.#ch = channel;
  }

  get channelId(): string {
    return this.#snap.channelId;
  }

  get ready(): boolean {
    return !this.#done && this.#snap.ready;
  }

  /** Same-stream figures only: a snapshot taken before the latest play or stop says nothing about it. */
  #current(): boolean {
    return this.#snap.streamId === this.#streamId;
  }

  play(stream: Readable, options?: PlayOptions): void {
    this.#unhook();
    const streamId = this.#ch.nextStreamId();
    this.#streamId = streamId;
    if (this.#done) return;
    this.#ch.post({ t: 'play', linkId: this.linkId, streamId, chunkMs: options?.chunkMs });
    // Each of these removes all of them, so only the first is passed on.
    const finish = (how: 'end' | 'error' | 'close', message?: string) => {
      this.#ch.post({ t: 'audioEnd', linkId: this.linkId, streamId, how, message });
      this.#unhook();
    };
    const onData = (chunk: Buffer) => {
      this.#ch.post({ t: 'audio', linkId: this.linkId, streamId, chunk }, ownBuffer(chunk));
    };
    const onEnd = () => finish('end');
    const onError = (err: Error) => finish('error', err.message);
    const onClose = () => finish('close');
    // As with the voice library's own pipeline: a stream error is reported, never thrown.
    stream.on('error', noop);
    stream.on('data', onData);
    stream.on('end', onEnd);
    stream.on('error', onError);
    stream.on('close', onClose);
    this.#hook = {
      streamId,
      stream,
      off: () => {
        stream.off('data', onData);
        stream.off('end', onEnd);
        stream.off('error', onError);
        stream.off('close', onClose);
      },
    };
  }

  #unhook(): void {
    this.#hook?.off();
    this.#hook = null;
  }

  stopAudio(): void {
    this.#unhook();
    this.#streamId = 0;
    if (!this.#done) this.#ch.post({ t: 'stopAudio', linkId: this.linkId });
  }

  playbackMs(): number {
    return this.#streamId !== 0 && this.#current() ? this.#snap.playbackMs : 0;
  }

  playerStatus(): string {
    if (this.#current()) return this.#snap.playerStatus;
    return this.#streamId === 0 ? 'idle' : 'buffering';
  }

  encryption(): string {
    return this.#snap.encryption;
  }

  stats(): VoiceLinkStats {
    // The live queue's figures, like the playback ones, belong to the stream playing now only.
    if (this.#current() || this.#snap.stats.live === null) return this.#snap.stats;
    return { ...this.#snap.stats, live: null };
  }

  armReports(): void {
    if (!this.#done) this.#ch.post({ t: 'reports', linkId: this.linkId, on: true });
  }

  disarmReports(): void {
    if (!this.#done) this.#ch.post({ t: 'reports', linkId: this.linkId, on: false });
  }

  /** Asks the worker, which holds the report and the key, to read it now. */
  receiverReport(): Promise<ReceiverReportReading> {
    if (this.#done) return Promise.resolve({ state: 'off' });
    const requestId = ++this.#nextReportRead;
    return new Promise((resolve) => {
      const timer = setTimeout(
        () => settle({ state: 'unreadable', reason: 'the voice worker did not answer in time' }),
        REPORT_READ_TIMEOUT_MS,
      );
      timer.unref?.();
      const settle = (reading: ReceiverReportReading) => {
        clearTimeout(timer);
        this.#reportReads.delete(requestId);
        resolve(reading);
      };
      this.#reportReads.set(requestId, settle);
      this.#ch.post({ t: 'readReport', linkId: this.linkId, requestId });
    });
  }

  /** The link is done: any read still waiting is answered at once. */
  #settleReportReads(): void {
    for (const settle of [...this.#reportReads.values()]) settle({ state: 'off' });
  }

  /** A newer snapshot from the worker. */
  update(snapshot: LinkSnapshot): void {
    this.#snap = snapshot;
  }

  /** A message for this link; once it is done, the voice thread no longer routes any to it. */
  receive(msg: LinkMessage): void {
    switch (msg.t) {
      case 'lost':
        this.#gone(msg.reason);
        return;
      case 'audioEnded':
        // Only for the stream playing now, and once: the end of an earlier one is old news.
        if (msg.streamId === 0 || msg.streamId !== this.#streamId || msg.streamId === this.#endedStreamId)
          return;
        this.#endedStreamId = msg.streamId;
        this.emit('audioEnded', msg.error ? deserializeError(msg.error) : null);
        return;
      case 'reconnected':
        this.emit('reconnected');
        return;
      case 'connectionError':
        this.emit('connectionError', deserializeError(msg.error));
        return;
      case 'interrupted':
        this.emit('interrupted', msg.info);
        return;
      case 'restored':
        this.emit('restored', msg.info);
        return;
      case 'caughtUp':
        // A catch-up of a stream the session has since replaced or stopped is old news.
        if (msg.streamId !== 0 && msg.streamId === this.#streamId) this.emit('caughtUp', msg.event);
        return;
      case 'flow':
        if (this.#hook?.streamId !== msg.streamId) return;
        if (msg.paused) this.#hook.stream.pause();
        else this.#hook.stream.resume();
        return;
      case 'report':
        this.#reportReads.get(msg.requestId)?.(msg.reading);
        return;
    }
  }

  /** The worker stopped: the connection is gone (the session reconnects, through a new worker). */
  workerGone(): void {
    this.#gone('destroyed');
  }

  #gone(reason: 'kicked' | 'destroyed' | 'reconnect_failed'): void {
    this.#done = true;
    this.#unhook();
    this.#settleReportReads();
    this.#ch.forget(this.linkId);
    this.#markLost(reason);
  }

  #markLost(reason: 'kicked' | 'destroyed' | 'reconnect_failed'): void {
    if (this.listenerCount('lost') === 0) return;
    this.emit('lost', reason);
    this.removeAllListeners('lost');
  }

  detach(): void {
    if (this.#done) return;
    this.#done = true;
    this.#unhook();
    this.#settleReportReads();
    this.#ch.post({ t: 'detach', linkId: this.linkId });
    this.#ch.forget(this.linkId);
    this.removeAllListeners();
  }

  destroy(): void {
    if (this.#done) return;
    this.#done = true;
    this.#unhook();
    this.#settleReportReads();
    this.#ch.post({ t: 'destroy', linkId: this.linkId });
    this.#ch.forget(this.linkId);
    this.#markLost('destroyed');
    this.removeAllListeners();
  }
}
