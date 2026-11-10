import { PassThrough } from 'node:stream';
import { DiscordVoiceLink, type VoiceJoinTarget, type VoiceLink } from '../link.ts';
import type { ReceiverReportReading } from '../receiver-report.ts';
import { AdapterRelay } from './adapter-relay.ts';
import {
  type FromWorker,
  type LinkSnapshot,
  type LogLevel,
  type SelfTestResult,
  serializeError,
  type ToWorker,
  type WorkerTelemetry,
} from './protocol.ts';

/** The worker's end of the channel to the main thread (`parentPort`, or a MessagePort in tests). */
export interface HostPort {
  postMessage(msg: FromWorker): void;
  on(event: 'message', listener: (msg: ToWorker) => void): unknown;
}

export interface VoiceHostDeps {
  port: HostPort;
  /** Joins a channel; @discordjs/voice through `DiscordVoiceLink` unless a test passes a fake. */
  connect?: (target: VoiceJoinTarget, timeoutMs: number) => Promise<VoiceLink>;
  /** Called when the main thread could not send a join payload (see `AdapterRelay`). */
  markAdapterUnavailable?: (guildId: string) => void;
  telemetry?: { sample(links: number): WorkerTelemetry; rotate(): void; stop(): void };
  selfTest?: () => SelfTestResult;
  /** How often every link's figures are pushed, ms (also on every change). */
  snapshotIntervalMs?: number;
  telemetryIntervalMs?: number;
  /** Length of a telemetry window, ms. */
  telemetryWindowMs?: number;
  /** Audio buffered in the worker before it asks the main thread to pause the encoder output. */
  highWaterMark?: number;
}

interface HostStream {
  id: number;
  pass: PassThrough;
  paused: boolean;
}

interface HostLink {
  id: number;
  link: VoiceLink;
  stream: HostStream | null;
  snapshotQueued: boolean;
}

/**
 * 256 KB. The link's live queue reads each stream's PassThrough eagerly, so it stays all but empty
 * and adds no delay: the backlog, if any, is in the queue, where it is measured and kept small.
 * This limit is only a safety net (the encoder's output is paused if the worker ever stops reading),
 * and is left large so a worker busy for a moment never pauses and resumes the encoder needlessly.
 */
export const DEFAULT_HIGH_WATER_MARK = 256 * 1024;

const noop = () => {};

/**
 * Runs every voice link in the voice worker: the connection, the player and the live queue with
 * its Ogg demuxer (demux only: the encoder on the main thread made the one and only Opus encode),
 * so the queue sits right next to the 20 ms sender and measures the delay where it is. The main
 * thread's `WorkerVoiceLink` proxies talk to it by message. This thread does nothing else, so the
 * 20 ms packet timer is never held up by commands, database queries or the main heap's GC.
 */
export class VoiceHost {
  readonly #port: HostPort;
  readonly #connect: (target: VoiceJoinTarget, timeoutMs: number) => Promise<VoiceLink>;
  readonly #relay: AdapterRelay;
  readonly #telemetry: VoiceHostDeps['telemetry'];
  readonly #selfTest: (() => SelfTestResult) | undefined;
  readonly #hwm: number;
  readonly #links = new Map<number, HostLink>();
  readonly #timers: NodeJS.Timeout[] = [];
  #closing = false;

  constructor(deps: VoiceHostDeps) {
    this.#port = deps.port;
    this.#connect = deps.connect ?? ((target, timeoutMs) => DiscordVoiceLink.connect(target, timeoutMs));
    this.#relay = new AdapterRelay((msg) => this.#post(msg), deps.markAdapterUnavailable);
    this.#telemetry = deps.telemetry;
    this.#selfTest = deps.selfTest;
    this.#hwm = deps.highWaterMark ?? DEFAULT_HIGH_WATER_MARK;
    this.#port.on('message', (msg) => this.#handle(msg));
    this.#timers.push(setInterval(() => this.#pushAll(), deps.snapshotIntervalMs ?? 1_000));
    if (this.#telemetry) {
      const telemetry = this.#telemetry;
      const send = (rotated: boolean) =>
        this.#post({ t: 'telemetry', telemetry: telemetry.sample(this.#links.size), rotated });
      this.#timers.push(
        setInterval(() => send(false), deps.telemetryIntervalMs ?? 5_000),
        setInterval(() => {
          telemetry.rotate();
          send(true);
        }, deps.telemetryWindowMs ?? 60_000),
      );
    }
    this.#post({ t: 'ready' });
  }

  get links(): number {
    return this.#links.size;
  }

  #post(msg: FromWorker): void {
    this.#port.postMessage(msg);
  }

  log(level: LogLevel, msg: string, data?: Record<string, unknown>): void {
    this.#post(data ? { t: 'log', level, msg, data } : { t: 'log', level, msg });
  }

  #handle(msg: ToWorker): void {
    try {
      this.#dispatch(msg);
    } catch (err) {
      // A fault handling one message must not take every guild's audio down with the worker.
      this.log('error', 'voice worker could not handle a message', { type: msg.t, err: serializeError(err) });
    }
  }

  #dispatch(msg: ToWorker): void {
    switch (msg.t) {
      case 'join':
        void this.#join(msg.linkId, { guildId: msg.guildId, channelId: msg.channelId }, msg.timeoutMs);
        return;
      case 'play':
        this.#play(msg.linkId, msg.streamId, msg.chunkMs);
        return;
      case 'audio':
        this.#audio(msg.linkId, msg.streamId, msg.chunk);
        return;
      case 'audioEnd':
        this.#audioEnd(msg.linkId, msg.streamId, msg.how, msg.message);
        return;
      case 'stopAudio': {
        const entry = this.#links.get(msg.linkId);
        if (!entry) return;
        entry.link.stopAudio();
        this.#endStream(entry);
        this.#queueSnapshot(entry);
        return;
      }
      case 'detach':
      case 'destroy':
        this.#release(msg.linkId, msg.t);
        return;
      case 'reports': {
        const link = this.#links.get(msg.linkId)?.link;
        if (msg.on) link?.armReports();
        else link?.disarmReports();
        return;
      }
      case 'readReport':
        void this.#readReport(msg.linkId, msg.requestId);
        return;
      case 'gateway':
        this.#relay.gateway(msg.adapterId, msg.kind, msg.data);
        return;
      case 'adapterDestroy':
        this.#relay.destroyed(msg.adapterId);
        return;
      case 'sendFailed':
        this.#relay.sendFailed(msg.adapterId);
        return;
      case 'gatewayReady':
        this.#relay.setGatewayReady(msg.ready);
        return;
      case 'selfTest':
        if (this.#selfTest) this.#post({ t: 'selfTest', result: this.#selfTest() });
        return;
      case 'shutdown':
        this.shutdown();
        return;
    }
  }

  async #join(
    linkId: number,
    where: { guildId: string; channelId: string },
    timeoutMs: number,
  ): Promise<void> {
    let link: VoiceLink;
    try {
      link = await this.#connect(
        { ...where, adapterCreator: this.#relay.creatorFor(where.guildId) },
        timeoutMs,
      );
    } catch (err) {
      this.#post({ t: 'joinFailed', linkId, error: serializeError(err) });
      return;
    }
    if (this.#closing) {
      link.destroy();
      this.#post({
        t: 'joinFailed',
        linkId,
        error: serializeError(new Error('The voice worker is stopping.')),
      });
      return;
    }
    const entry: HostLink = { id: linkId, link, stream: null, snapshotQueued: false };
    this.#links.set(linkId, entry);
    link.on('lost', (reason) => {
      this.#post({ t: 'lost', linkId, reason });
      // Gone for good: nothing will ask for this link again.
      this.#release(linkId, 'destroy');
    });
    link.on('audioEnded', (err) =>
      this.#post({
        t: 'audioEnded',
        linkId,
        streamId: entry.stream?.id ?? 0,
        error: err ? serializeError(err) : null,
      }),
    );
    link.on('reconnected', () => this.#post({ t: 'reconnected', linkId }));
    link.on('connectionError', (err) =>
      this.#post({ t: 'connectionError', linkId, error: serializeError(err) }),
    );
    link.on('interrupted', (info) => this.#post({ t: 'interrupted', linkId, info }));
    link.on('restored', (info) => this.#post({ t: 'restored', linkId, info }));
    link.on('recovering', (info) => this.#post({ t: 'recovering', linkId, info }));
    link.on('caughtUp', (event) =>
      this.#post({ t: 'caughtUp', linkId, streamId: entry.stream?.id ?? 0, event }),
    );
    link.on('changed', () => this.#queueSnapshot(entry));
    this.#post({ t: 'joined', linkId, snapshot: this.#snapshot(entry) });
  }

  #play(linkId: number, streamId: number, chunkMs: number | undefined): void {
    const entry = this.#links.get(linkId);
    if (!entry) return;
    const previous = entry.stream;
    const pass = new PassThrough({ highWaterMark: this.#hwm });
    // The player's own pipeline reports stream errors; this only keeps a late one from throwing.
    pass.on('error', noop);
    const stream: HostStream = { id: streamId, pass, paused: false };
    pass.on('drain', () => {
      if (entry.stream !== stream || !stream.paused) return;
      stream.paused = false;
      this.#post({ t: 'flow', linkId, streamId, paused: false });
    });
    entry.stream = stream;
    // The link's live queue reads `pass` eagerly, here in the worker, and keeps the backlog itself.
    entry.link.play(pass, chunkMs === undefined ? undefined : { chunkMs });
    // Only now that the player has moved on to the new resource: the old one ending is no news.
    if (previous && !previous.pass.destroyed) previous.pass.destroy();
    this.#queueSnapshot(entry);
  }

  #audio(linkId: number, streamId: number, chunk: Uint8Array): void {
    const stream = this.#links.get(linkId)?.stream;
    if (!stream || stream.id !== streamId || stream.pass.destroyed || stream.pass.writableEnded) return;
    // Backpressure reaches the encoder as before: the main thread pauses its output until 'drain'.
    if (!stream.pass.write(chunk) && !stream.paused) {
      stream.paused = true;
      this.#post({ t: 'flow', linkId, streamId, paused: true });
    }
  }

  #audioEnd(linkId: number, streamId: number, how: 'end' | 'error' | 'close', message?: string): void {
    const stream = this.#links.get(linkId)?.stream;
    if (!stream || stream.id !== streamId || stream.pass.destroyed) return;
    if (how === 'end') stream.pass.end();
    else if (how === 'error') stream.pass.destroy(new Error(message ?? 'The audio stream failed.'));
    else stream.pass.destroy();
  }

  /** Decrypts the link's latest receiver report here, where its key is, and sends back only the figures. */
  async #readReport(linkId: number, requestId: number): Promise<void> {
    const link = this.#links.get(linkId)?.link;
    let reading: ReceiverReportReading = { state: 'off' };
    try {
      if (link) reading = await link.receiverReport();
    } catch (err) {
      reading = { state: 'unreadable', reason: serializeError(err).message };
    }
    this.#post({ t: 'report', linkId, requestId, reading });
  }

  #endStream(entry: HostLink): void {
    const stream = entry.stream;
    entry.stream = null;
    if (stream && !stream.pass.destroyed) stream.pass.destroy();
  }

  #release(linkId: number, how: 'detach' | 'destroy'): void {
    const entry = this.#links.get(linkId);
    if (!entry) return;
    this.#links.delete(linkId);
    // The main thread has already let go of its proxy: nothing more is reported for this link.
    entry.link.removeAllListeners();
    if (how === 'detach') entry.link.detach();
    else entry.link.destroy();
    this.#endStream(entry);
  }

  #snapshot(entry: HostLink): LinkSnapshot {
    const link = entry.link;
    return {
      channelId: link.channelId,
      ready: link.ready,
      playerStatus: link.playerStatus(),
      playbackMs: link.playbackMs(),
      streamId: entry.stream?.id ?? 0,
      encryption: link.encryption(),
      stats: link.stats(),
    };
  }

  /** State changes come in bunches (a reconnect passes through several); one snapshot covers them. */
  #queueSnapshot(entry: HostLink): void {
    if (entry.snapshotQueued) return;
    entry.snapshotQueued = true;
    queueMicrotask(() => {
      entry.snapshotQueued = false;
      if (this.#links.get(entry.id) === entry) {
        this.#post({ t: 'snapshot', linkId: entry.id, snapshot: this.#snapshot(entry) });
      }
    });
  }

  #pushAll(): void {
    if (this.#links.size === 0) return;
    const links: Array<[number, LinkSnapshot]> = [];
    for (const entry of this.#links.values()) links.push([entry.id, this.#snapshot(entry)]);
    this.#post({ t: 'snapshots', links });
  }

  /**
   * Leaves every channel (the leave payloads go out through the main thread, which is still
   * relaying), stops the timers and says goodbye; the main thread then ends the worker.
   */
  shutdown(): void {
    if (this.#closing) return;
    this.#closing = true;
    for (const id of [...this.#links.keys()]) this.#release(id, 'destroy');
    for (const t of this.#timers) clearInterval(t);
    this.#telemetry?.stop();
    this.#post({ t: 'bye' });
  }
}
