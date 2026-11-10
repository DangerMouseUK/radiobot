import { EventEmitter } from 'node:events';
import { PassThrough, type Readable } from 'node:stream';
import { MessageChannel, type MessagePort } from 'node:worker_threads';
import type { DiscordGatewayAdapterLibraryMethods } from '@discordjs/voice';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RadioError } from '../../src/shared/errors.ts';
import type { VoiceJoinTarget, VoiceLinkStats } from '../../src/voice/link.ts';
import { VoiceThread, type VoiceWorkerLike, WorkerVoiceLink } from '../../src/voice/voice-thread.ts';
import { VoiceHost, type VoiceHostDeps } from '../../src/voice/worker/host.ts';
import type { FromWorker, LinkSnapshot, ToWorker, WorkerTelemetry } from '../../src/voice/worker/protocol.ts';
import { silentLogger } from '../helpers.ts';

const baseStats = (): VoiceLinkStats => ({
  wsPingMs: 5,
  endpoint: null,
  packetsPlayed: null,
  packetTiming: { late: 0, worstGapMs: null, recent: [] },
  silenceMs: null,
  encryptionMode: null,
  status: 'ready',
  live: null,
});

/** A voice link as the worker's host sees it: what `DiscordVoiceLink` does, without any network. */
class FakeLink extends EventEmitter {
  channelId: string;
  ready = true;
  status = 'idle';
  ms = 0;
  played: PassThrough[] = [];
  playOptions: unknown[] = [];
  stops = 0;
  detached = false;
  destroyed = false;
  statsValue = baseStats();
  constructor(channelId: string) {
    super();
    this.channelId = channelId;
  }
  play(stream: PassThrough, options?: unknown) {
    this.played.push(stream);
    this.playOptions.push(options);
    this.status = 'buffering';
  }
  stopAudio() {
    this.stops++;
    this.status = 'idle';
  }
  playbackMs() {
    return this.ms;
  }
  playerStatus() {
    return this.status;
  }
  encryption() {
    return 'DAVE end-to-end encrypted (privacy code 12345)';
  }
  stats() {
    return this.statsValue;
  }
  /** Arm and disarm calls, in order, and what a read answers (a function, so a test can make it hang or throw). */
  reportCalls: string[] = [];
  readReport: () => Promise<unknown> = async () => ({ state: 'waiting' });
  armReports() {
    this.reportCalls.push('arm');
  }
  disarmReports() {
    this.reportCalls.push('disarm');
  }
  receiverReport() {
    return this.readReport();
  }

  detach() {
    this.detached = true;
  }
  destroy() {
    this.destroyed = true;
  }
}

const telemetrySample = (links: number): WorkerTelemetry => ({
  loopDelay: { current: { meanMs: 0.2, p99Ms: 1, maxMs: 2, windowSec: 5 }, lastWindow: null },
  gc: { current: { count: 1, major: 0, maxMs: 0.5, totalMs: 0.5 }, lastWindow: null },
  heapUsedMb: 12,
  heapTotalMb: 20,
  externalMb: 1,
  arrayBuffersMb: 0.5,
  links,
  at: 0,
});

interface Harness {
  workers: Array<
    VoiceWorkerLike & EventEmitter & { host: VoiceHost; terminated: boolean; port: MessagePort }
  >;
  links: FakeLink[];
  targets: VoiceJoinTarget[];
  /** The library's side of each adapter the worker opened, and what the library got through it. */
  library: Array<{
    methods: DiscordGatewayAdapterLibraryMethods;
    server: unknown[];
    state: unknown[];
    destroyed: number;
  }>;
  implementers: Array<{ sendPayload(p: unknown): boolean; destroy(): void }>;
  unavailable: string[];
  /** Makes the next join fail (or hang, with 'hang'). */
  failNext: Error | 'hang' | null;
}

const ports: MessagePort[] = [];

/** A worker made of a MessageChannel: the real host runs in this thread, over real message passing. */
function harness(hostDeps: Partial<VoiceHostDeps> = {}): Harness & { spawn: () => VoiceWorkerLike } {
  const h: Harness = {
    workers: [],
    links: [],
    targets: [],
    library: [],
    implementers: [],
    unavailable: [],
    failNext: null,
  };
  const spawn = () => {
    const { port1, port2 } = new MessageChannel();
    ports.push(port1, port2);
    const worker = Object.assign(new EventEmitter(), {
      terminated: false,
      port: port1,
      host: null as unknown as VoiceHost,
      postMessage: (msg: ToWorker, transfer?: readonly ArrayBuffer[]) =>
        port1.postMessage(msg, transfer ?? []),
      terminate: async () => {
        if (worker.terminated) return 1;
        worker.terminated = true;
        worker.host.shutdown();
        port1.close();
        port2.close();
        queueMicrotask(() => worker.emit('exit', 1));
        return 1;
      },
    });
    port1.on('message', (msg: FromWorker) => worker.emit('message', msg));
    worker.host = new VoiceHost({
      port: port2 as never,
      connect: async (target) => {
        h.targets.push(target);
        const failure = h.failNext;
        h.failNext = null;
        if (failure === 'hang') return new Promise(() => {});
        // The library opens its adapter as it joins.
        const record = {
          methods: null as unknown as DiscordGatewayAdapterLibraryMethods,
          server: [] as unknown[],
          state: [] as unknown[],
          destroyed: 0,
        };
        record.methods = {
          onVoiceServerUpdate: (d) => record.server.push(d),
          onVoiceStateUpdate: (d) => record.state.push(d),
          destroy: () => record.destroyed++,
        };
        h.library.push(record);
        h.implementers.push(target.adapterCreator(record.methods));
        if (failure) throw failure;
        const link = new FakeLink(target.channelId);
        h.links.push(link);
        return link as never;
      },
      markAdapterUnavailable: (guildId) => h.unavailable.push(guildId),
      telemetry: { sample: telemetrySample, rotate: () => {}, stop: () => {} },
      selfTest: () => ({ ok: true, daveProtocolVersion: 1, heapUsedMb: 10, error: null }),
      snapshotIntervalMs: 20,
      telemetryIntervalMs: 20,
      telemetryWindowMs: 50,
      ...hostDeps,
    });
    h.workers.push(worker as never);
    return worker as unknown as VoiceWorkerLike;
  };
  return Object.assign(h, { spawn });
}

/** A discord.js voice channel whose guild adapter records what the worker relays to the gateway. */
function channel(guildId = 'g1', channelId = 'voice-1') {
  const gateway = {
    sent: [] as unknown[],
    accept: true,
    destroyed: 0,
    methods: null as unknown as DiscordGatewayAdapterLibraryMethods,
  };
  const voiceAdapterCreator = (methods: DiscordGatewayAdapterLibraryMethods) => {
    gateway.methods = methods;
    return {
      sendPayload: (p: unknown) => {
        gateway.sent.push(p);
        return gateway.accept;
      },
      destroy: () => gateway.destroyed++,
    };
  };
  return { channel: { id: channelId, guild: { id: guildId, voiceAdapterCreator } } as never, gateway };
}

const threads: VoiceThread[] = [];
function thread(
  h: { spawn: () => VoiceWorkerLike },
  opts: Partial<ConstructorParameters<typeof VoiceThread>[0]> = {},
) {
  const t = new VoiceThread({ logger: silentLogger(), spawn: h.spawn, restartDelayMs: () => 5, ...opts });
  threads.push(t);
  return t;
}

afterEach(async () => {
  vi.useRealTimers();
  for (const t of threads.splice(0)) await t.stop();
  for (const p of ports.splice(0)) p.close();
});

describe('VoiceThread: joining', () => {
  it('starts the worker, and joins through it with the guild and channel', async () => {
    const h = harness();
    const t = thread(h);
    expect(t.alive).toBe(false);
    await t.start();
    expect(t.alive).toBe(true);
    const { channel: ch } = channel('g1', 'voice-1');
    const link = await t.factory()(ch);
    expect(link).toBeInstanceOf(WorkerVoiceLink);
    expect(h.targets[0]).toMatchObject({ guildId: 'g1', channelId: 'voice-1' });
    expect(link.channelId).toBe('voice-1');
    expect(link.ready).toBe(true);
    expect(link.encryption()).toMatch(/DAVE/);
    expect(link.stats()).toEqual(baseStats());
    // Starting again does nothing new.
    await t.start();
    expect(h.workers).toHaveLength(1);
  });

  it('passes a failed join on as the error the worker saw', async () => {
    const h = harness();
    const t = thread(h);
    await t.start();
    h.failNext = new RadioError('VOICE_CONNECT_TIMEOUT', 'Could not connect to the voice channel in time.');
    await expect(t.factory()(channel().channel)).rejects.toMatchObject({ code: 'VOICE_CONNECT_TIMEOUT' });
    h.failNext = new Error('adapter gone');
    await expect(t.factory()(channel().channel)).rejects.toThrow('adapter gone');
  });

  it('gives up on a worker that never answers a join, and lets that link go if it comes late', async () => {
    const h = harness();
    const t = thread(h, { joinTimeoutMs: 10 });
    await t.start();
    h.failNext = 'hang';
    // The main thread allows the worker's own limit plus five seconds.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const joining = t.factory()(channel().channel);
    const outcome = joining.catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(5_010);
    expect(await outcome).toMatchObject({ code: 'VOICE_CONNECT_TIMEOUT' });
    vi.useRealTimers();
    // A late "joined" for it is answered with a destroy.
    const posted: ToWorker[] = [];
    const worker = h.workers[0]!;
    const post = worker.postMessage.bind(worker);
    worker.postMessage = (m: ToWorker, tr?: readonly ArrayBuffer[]) => {
      posted.push(m);
      post(m, tr);
    };
    worker.emit('message', { t: 'joined', linkId: 1, snapshot: {} as LinkSnapshot } satisfies FromWorker);
    worker.emit('message', {
      t: 'joinFailed',
      linkId: 1,
      error: { name: 'Error', message: 'x' },
    } satisfies FromWorker);
    expect(posted).toEqual([{ t: 'destroy', linkId: 1 }]);
  });

  it('refuses joins before it starts and after it stops', async () => {
    const h = harness();
    const t = thread(h);
    await expect(t.factory()(channel().channel)).rejects.toMatchObject({ code: 'VOICE_CONNECT_TIMEOUT' });
    await t.start();
    await t.stop();
    await expect(t.factory()(channel().channel)).rejects.toMatchObject({ code: 'VOICE_CONNECT_TIMEOUT' });
    await expect(t.start()).rejects.toThrow(/stopped/);
    await t.stop();
  });
});

describe('VoiceThread: the gateway relay', () => {
  it('relays the library’s payloads to the guild’s gateway, and the gateway’s updates back', async () => {
    const h = harness();
    const t = thread(h);
    await t.start();
    const { channel: ch, gateway } = channel('g1');
    await t.factory()(ch);
    const implementer = h.implementers[0]!;
    const library = h.library[0]!;
    // Library → gateway: answered at once from the mirrored gateway state, sent by the main thread.
    expect(implementer.sendPayload({ op: 4, d: { guild_id: 'g1' } })).toBe(true);
    await vi.waitFor(() => expect(gateway.sent).toEqual([{ op: 4, d: { guild_id: 'g1' } }]));
    // Gateway → library.
    gateway.methods.onVoiceServerUpdate({
      token: 'voice-token',
      guild_id: 'g1',
      endpoint: 'c-test01.discord.media',
    });
    gateway.methods.onVoiceStateUpdate({ session_id: 'abc' } as never);
    await vi.waitFor(() => expect(library.state).toEqual([{ session_id: 'abc' }]));
    expect(library.server).toEqual([
      { token: 'voice-token', guild_id: 'g1', endpoint: 'c-test01.discord.media' },
    ]);
    // The gateway lets go of the adapter (a shard disconnected): the library hears of it.
    gateway.methods.destroy();
    await vi.waitFor(() => expect(library.destroyed).toBe(1));
    // The library is done with the adapter: the gateway's is released too.
    implementer.destroy();
    implementer.destroy();
    await vi.waitFor(() => expect(gateway.destroyed).toBe(1));
    // A closed adapter sends nothing.
    expect(implementer.sendPayload({ op: 4 })).toBe(false);
  });

  it('mirrors whether the gateway can send, and reports a payload that failed anyway', async () => {
    const h = harness();
    const t = thread(h);
    t.setGatewayReady(false); // before start: the new worker is told at once
    await t.start();
    const { channel: ch, gateway } = channel('g7');
    await t.factory()(ch);
    const implementer = h.implementers[0]!;
    expect(implementer.sendPayload({ op: 4 })).toBe(false);
    t.setGatewayReady(true);
    await vi.waitFor(() => expect(implementer.sendPayload({ op: 4, n: 1 })).toBe(true));
    await vi.waitFor(() => expect(gateway.sent).toEqual([{ op: 4, n: 1 }]));
    // The shard went down before the main thread could send: the worker's connection is told.
    gateway.accept = false;
    implementer.sendPayload({ op: 4, n: 2 });
    await vi.waitFor(() => expect(h.unavailable).toEqual(['g7']));
  });

  it('closes an adapter the main thread has no gateway for', async () => {
    const h = harness();
    const t = thread(h);
    await t.start();
    h.workers[0]!.emit('message', {
      t: 'adapterOpen',
      adapterId: 99,
      guildId: 'nowhere',
    } satisfies FromWorker);
    h.workers[0]!.emit('message', { t: 'send', adapterId: 99, payload: {} } satisfies FromWorker);
    h.workers[0]!.emit('message', { t: 'adapterClose', adapterId: 99 } satisfies FromWorker);
    // Nothing to assert beyond not throwing; the worker side has no adapter 99 and ignores the replies.
    await new Promise((r) => setTimeout(r, 10));
    expect(t.alive).toBe(true);
  });
});

/** Collects what the worker's player reads. */
function drain(stream: Readable): Buffer[] {
  const out: Buffer[] = [];
  stream.on('data', (c: Buffer) => out.push(c));
  return out;
}

describe('VoiceThread: audio', () => {
  it('passes the encoder’s pages to the worker’s player as they are, and their end', async () => {
    const h = harness();
    const t = thread(h);
    await t.start();
    const link = await t.factory()(channel().channel);
    const source = new PassThrough();
    link.play(source);
    expect(link.playerStatus()).toBe('buffering');
    expect(link.playbackMs()).toBe(0);
    await vi.waitFor(() => expect(h.links[0]!.played).toHaveLength(1));
    const received = drain(h.links[0]!.played[0]!);
    source.write(Buffer.from('OggS page one'));
    source.write(Buffer.alloc(4096, 7)); // its own ArrayBuffer: handed over, not copied
    source.end();
    await vi.waitFor(() => expect(h.links[0]!.played[0]!.readableEnded).toBe(true));
    expect(Buffer.concat(received)).toEqual(
      Buffer.concat([Buffer.from('OggS page one'), Buffer.alloc(4096, 7)]),
    );
  });

  it('pauses the encoder’s output while the worker’s buffer is full, and resumes it on drain', async () => {
    const h = harness({ highWaterMark: 16 });
    const t = thread(h);
    await t.start();
    const link = await t.factory()(channel().channel);
    const source = new PassThrough();
    link.play(source);
    await vi.waitFor(() => expect(h.links[0]!.played).toHaveLength(1));
    source.write(Buffer.alloc(64, 1));
    await vi.waitFor(() => expect(source.isPaused()).toBe(true));
    // The player reads: the buffer drains and the encoder's output flows again.
    drain(h.links[0]!.played[0]!);
    await vi.waitFor(() => expect(source.isPaused()).toBe(false));
  });

  it('reports the playback figures of the stream playing now, never an earlier one', async () => {
    const h = harness();
    const t = thread(h);
    await t.start();
    const link = await t.factory()(channel().channel);
    link.play(new PassThrough());
    await vi.waitFor(() => expect(h.links[0]!.played).toHaveLength(1));
    const fake = h.links[0]!;
    fake.ms = 1_240;
    fake.status = 'playing';
    fake.emit('changed');
    await vi.waitFor(() => expect(link.playbackMs()).toBe(1_240));
    expect(link.playerStatus()).toBe('playing');
    // A new stream starts from nothing, whatever the worker last said about the old one.
    link.play(new PassThrough());
    expect(link.playbackMs()).toBe(0);
    expect(link.playerStatus()).toBe('buffering');
    link.stopAudio();
    expect(link.playbackMs()).toBe(0);
    expect(link.playerStatus()).toBe('idle');
    await vi.waitFor(() => expect(fake.stops).toBe(1));
  });

  it('reports the end of the audio for the stream playing now, once', async () => {
    const h = harness();
    const t = thread(h);
    await t.start();
    const link = await t.factory()(channel().channel);
    const ended: Array<Error | null> = [];
    link.on('audioEnded', (e) => ended.push(e));
    link.play(new PassThrough());
    await vi.waitFor(() => expect(h.links[0]!.played).toHaveLength(1));
    const fake = h.links[0]!;
    fake.emit('audioEnded', null);
    fake.emit('audioEnded', null);
    await vi.waitFor(() => expect(ended).toEqual([null]));
    link.play(new PassThrough());
    await vi.waitFor(() => expect(fake.played).toHaveLength(2));
    fake.emit('audioEnded', new Error('resource error'));
    await vi.waitFor(() => expect(ended).toHaveLength(2));
    expect(ended[1]).toBeInstanceOf(Error);
    expect(ended[1]!.message).toBe('resource error');
    // An end the worker reported for a stream the session has since stopped is dropped.
    link.stopAudio();
    const worker = h.workers[0]!;
    worker.emit('message', { t: 'audioEnded', linkId: 1, streamId: 2, error: null } satisfies FromWorker);
    worker.emit('message', { t: 'audioEnded', linkId: 1, streamId: 0, error: null } satisfies FromWorker);
    expect(ended).toHaveLength(2);
  });

  it('fails the worker’s stream when the encoder output fails or closes early, never throwing here', async () => {
    const h = harness();
    const t = thread(h);
    await t.start();
    const link = await t.factory()(channel().channel);
    const failing = new PassThrough();
    link.play(failing);
    await vi.waitFor(() => expect(h.links[0]!.played).toHaveLength(1));
    const first = h.links[0]!.played[0]!;
    const errors: string[] = [];
    first.on('error', (e) => errors.push(e.message));
    failing.destroy(new Error('encoder pipe broke'));
    await vi.waitFor(() => expect(errors).toEqual(['encoder pipe broke']));
    // A stream destroyed without an error (as a pipeline stop does) ends the worker's stream too.
    const closing = new PassThrough();
    link.play(closing);
    await vi.waitFor(() => expect(h.links[0]!.played).toHaveLength(2));
    closing.destroy();
    await vi.waitFor(() => expect(h.links[0]!.played[1]!.destroyed).toBe(true));
    // A stream the link has moved on from may still fail later: nothing throws.
    const old = new PassThrough();
    link.play(old);
    link.play(new PassThrough());
    expect(() => old.destroy(new Error('late failure'))).not.toThrow();
  });

  it('ignores flow control meant for an earlier stream', async () => {
    const h = harness();
    const t = thread(h);
    await t.start();
    const link = await t.factory()(channel().channel);
    const source = new PassThrough();
    link.play(source);
    source.on('data', () => {});
    h.workers[0]!.emit('message', { t: 'flow', linkId: 1, streamId: 999, paused: true } satisfies FromWorker);
    expect(source.isPaused()).toBe(false);
  });

  it('passes on connection errors and reconnects', async () => {
    const h = harness();
    const t = thread(h);
    await t.start();
    const link = await t.factory()(channel().channel);
    const seen: string[] = [];
    link.on('connectionError', (e) => seen.push(e.message));
    link.on('reconnected', () => seen.push('reconnected'));
    h.links[0]!.emit('connectionError', new Error('udp socket closed'));
    h.links[0]!.emit('reconnected');
    await vi.waitFor(() => expect(seen).toEqual(['udp socket closed', 'reconnected']));
  });

  it('passes on a brief interruption and its recovery, as the link in the worker saw them', async () => {
    const h = harness();
    const t = thread(h);
    await t.start();
    const link = await t.factory()(channel().channel);
    const seen: unknown[] = [];
    link.on('interrupted', (info) => seen.push(info));
    link.on('restored', (info) => seen.push(info));
    const interruption = { status: 'connecting', resuming: true, closeCode: 1006 };
    const restore = { afterMs: 140, skippedMs: 140, caughtUpMs: 200 };
    h.links[0]!.emit('interrupted', interruption);
    h.links[0]!.emit('restored', restore);
    await vi.waitFor(() => expect(seen).toEqual([interruption, restore]));
  });

  it('passes on the steps the link in the worker takes to recover a stuck connection', async () => {
    const h = harness();
    const t = thread(h);
    await t.start();
    const link = await t.factory()(channel().channel);
    const seen: unknown[] = [];
    link.on('recovering', (info) => seen.push(info));
    const rejoin = { step: 'rejoin', status: 'signalling', afterMs: 30_000 } as const;
    const fresh = { step: 'fresh', status: 'signalling', afterMs: 45_000 } as const;
    h.links[0]!.emit('recovering', rejoin);
    h.links[0]!.emit('recovering', fresh);
    await vi.waitFor(() => expect(seen).toEqual([rejoin, fresh]));
  });

  it('tells the worker’s live queue how much audio arrives in one go', async () => {
    const h = harness();
    const t = thread(h);
    await t.start();
    const link = await t.factory()(channel().channel);
    link.play(new PassThrough(), { chunkMs: 6_000 });
    link.play(new PassThrough());
    await vi.waitFor(() => expect(h.links[0]!.playOptions).toEqual([{ chunkMs: 6_000 }, undefined]));
  });

  it('passes on the live queue’s catch-ups for the stream playing now only', async () => {
    const h = harness();
    const t = thread(h);
    await t.start();
    const link = await t.factory()(channel().channel);
    const seen: unknown[] = [];
    link.on('caughtUp', (event) => seen.push(event));
    const fake = h.links[0]!;
    // Nothing playing: nothing to pass on.
    fake.emit('caughtUp', { reason: 'gap', droppedMs: 100, cushionMs: 1_000 });
    link.play(new PassThrough());
    await vi.waitFor(() => expect(fake.played).toHaveLength(1));
    const start = { reason: 'start', droppedMs: 2_400, cushionMs: 1_000 };
    fake.emit('caughtUp', start);
    await vi.waitFor(() => expect(seen).toEqual([start]));
    // One the worker sent for a stream the session has since replaced is old news.
    link.play(new PassThrough());
    h.workers[0]!.emit('message', {
      t: 'caughtUp',
      linkId: 1,
      streamId: 1,
      event: { reason: 'resume', droppedMs: 300, cushionMs: 1_000 },
    } satisfies FromWorker);
    expect(seen).toEqual([start]);
  });

  it('reports the live queue’s figures from the worker, for the stream playing now only', async () => {
    const h = harness();
    const t = thread(h);
    await t.start();
    const link = await t.factory()(channel().channel);
    link.play(new PassThrough());
    await vi.waitFor(() => expect(h.links[0]!.played).toHaveLength(1));
    const fake = h.links[0]!;
    const live = {
      depthMs: 1_020,
      floorMs: 980,
      cushionMs: 1_000,
      startDroppedMs: 2_400,
      caughtUpMs: 0,
      catchUps: 0,
      gaps: 0,
      driftPpm: null,
    };
    fake.statsValue = { ...baseStats(), live };
    // Pushed every second (every 20 ms here) as well as on every change.
    await vi.waitFor(() => expect(link.stats().live).toEqual(live));
    link.play(new PassThrough());
    expect(link.stats().live).toBeNull();
    expect(link.stats().wsPingMs).toBe(5);
  });
});

describe('VoiceThread: Discord receiver reports', () => {
  it('arms, reads and disarms the reader in the worker; only figures come back', async () => {
    const h = harness();
    const t = thread(h);
    await t.start();
    const link = await t.factory()(channel().channel);
    const report = { lost: 3, expected: 1000, fractionLost: 0, jitterMs: 1.5, ageMs: 200 };
    h.links[0]!.readReport = async () => ({ state: 'ok', report });
    link.armReports();
    expect(await link.receiverReport()).toEqual({ state: 'ok', report });
    link.disarmReports();
    await vi.waitFor(() => expect(h.links[0]!.reportCalls).toEqual(['arm', 'disarm']));
  });

  it('gives up on a read the worker never answers, without keeping it', async () => {
    const h = harness();
    const t = thread(h);
    await t.start();
    const link = await t.factory()(channel().channel);
    h.links[0]!.readReport = () => new Promise(() => {});
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const reading = link.receiverReport();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await reading).toEqual({ state: 'unreadable', reason: 'the voice worker did not answer in time' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('answers a waiting read at once when the link goes, and sends nothing for a link that has gone', async () => {
    const h = harness();
    const t = thread(h);
    await t.start();
    const link = await t.factory()(channel().channel);
    h.links[0]!.readReport = () => new Promise(() => {});
    const reading = link.receiverReport();
    await vi.waitFor(() => expect(h.workers[0]!.host.links).toBe(1));
    link.destroy();
    expect(await reading).toEqual({ state: 'off' });
    expect(await link.receiverReport()).toEqual({ state: 'off' });
    link.armReports();
    link.disarmReports();
    await vi.waitFor(() => expect(h.links[0]!.destroyed).toBe(true));
    expect(h.links[0]!.reportCalls).toEqual([]);
  });
});

describe('VoiceThread: losing and letting go', () => {
  it('reports a lost connection once, and releases it in the worker', async () => {
    const h = harness();
    const t = thread(h);
    await t.start();
    const link = await t.factory()(channel().channel);
    const lost: string[] = [];
    link.on('lost', (r) => lost.push(r));
    h.links[0]!.emit('lost', 'kicked');
    await vi.waitFor(() => expect(lost).toEqual(['kicked']));
    expect(h.links[0]!.destroyed).toBe(true);
    expect(link.ready).toBe(false);
    expect(h.workers[0]!.host.links).toBe(0);
    // Already gone: destroying it again does nothing.
    link.destroy();
    expect(lost).toEqual(['kicked']);
  });

  it('detaches without destroying the shared connection, and destroys on request', async () => {
    const h = harness();
    const t = thread(h);
    await t.start();
    const first = await t.factory()(channel().channel);
    first.play(new PassThrough());
    first.detach();
    first.detach();
    await vi.waitFor(() => expect(h.links[0]!.detached).toBe(true));
    expect(h.links[0]!.destroyed).toBe(false);
    const second = await t.factory()(channel().channel);
    const lost: string[] = [];
    second.on('lost', (r) => lost.push(r));
    second.destroy();
    expect(lost).toEqual(['destroyed']);
    await vi.waitFor(() => expect(h.links[1]!.destroyed).toBe(true));
    // Nothing reaches a link the session has let go of.
    expect(second.listenerCount('lost')).toBe(0);
    second.play(new PassThrough());
    second.stopAudio();
  });

  it('when the worker stops: links are lost, joins fail, and a new worker starts after a backoff', async () => {
    const h = harness();
    const delays: number[] = [];
    let clock = 0;
    const t = thread(h, {
      restartDelayMs: (n) => {
        delays.push(n);
        return 5;
      },
      now: () => clock,
      stableAfterMs: 1_000,
    });
    await t.start();
    const link = await t.factory()(channel().channel);
    const lost: string[] = [];
    link.on('lost', (r) => lost.push(r));
    h.failNext = 'hang';
    const pending = t
      .factory()(channel().channel)
      .catch((e: unknown) => e);
    await vi.waitFor(() => expect(h.targets).toHaveLength(2));
    h.workers[0]!.emit('error', new Error('worker crashed'));
    expect(lost).toEqual(['destroyed']);
    expect(await pending).toMatchObject({ code: 'VOICE_CONNECT_TIMEOUT' });
    expect(t.alive).toBe(false);
    expect(h.workers[0]!.terminated).toBe(true);
    // A join while it restarts waits for the new worker.
    const again = await t.factory()(channel().channel);
    expect(again.ready).toBe(true);
    expect(h.workers).toHaveLength(2);
    // A second stop soon after backs off further; one after a long healthy run starts over.
    h.workers[1]!.emit('exit', 1);
    await vi.waitFor(() => expect(h.workers).toHaveLength(3));
    await t.start();
    clock += 5_000;
    h.workers[2]!.emit('exit', 1);
    await vi.waitFor(() => expect(h.workers).toHaveLength(4));
    expect(delays).toEqual([0, 1, 0]);
    await vi.waitFor(() => expect(t.stats()?.restarts).toBe(3));
  });

  it('restarts a worker that cannot be created or does not start in time', async () => {
    const h = harness();
    let calls = 0;
    const t = thread(
      {
        spawn: () => {
          calls++;
          if (calls === 1) throw new Error('cannot create');
          if (calls === 2)
            return Object.assign(new EventEmitter(), { postMessage() {}, terminate: async () => 1 }) as never;
          return h.spawn();
        },
      },
      { startTimeoutMs: 50 },
    );
    await expect(t.start()).rejects.toThrow(/not ready/);
    await vi.waitFor(() => expect(t.alive).toBe(true));
    expect(calls).toBe(3);
  });

  it('leaves every channel through the worker before it ends it', async () => {
    const h = harness();
    const t = thread(h);
    await t.start();
    await t.factory()(channel().channel);
    await t.stop();
    expect(h.links[0]!.destroyed).toBe(true);
    expect(h.workers[0]!.terminated).toBe(true);
    expect(t.alive).toBe(false);
  });

  it('does not wait long for a worker that never says goodbye', async () => {
    let terminated = false;
    const silent = Object.assign(new EventEmitter(), {
      postMessage(msg: ToWorker) {
        if (msg.t === 'shutdown') return;
      },
      terminate: async () => {
        terminated = true;
        return 1;
      },
    });
    const t = thread({ spawn: () => silent as never }, { stopTimeoutMs: 10 });
    const starting = t.start();
    silent.emit('message', { t: 'ready' } satisfies FromWorker);
    await starting;
    await t.stop();
    expect(terminated).toBe(true);
  });

  it('releases the guild’s gateway adapter when the worker stops, even one that fails to close', async () => {
    const h = harness();
    const t = thread(h);
    await t.start();
    const a = channel('g1');
    const b = channel('g2');
    await t.factory()(a.channel);
    await t.factory()(b.channel);
    // The worker that held the connections is gone: discord.js may drop the guilds' adapters.
    h.workers[0]!.emit('exit', 1);
    expect(a.gateway.destroyed).toBe(1);
    expect(b.gateway.destroyed).toBe(1);
  });

  it('cleans up after an adapter that throws as it closes, and a worker that cannot take a message', async () => {
    let posts = 0;
    const broken = Object.assign(new EventEmitter(), {
      postMessage(msg: ToWorker) {
        if (msg.t !== 'shutdown') posts++;
        if (msg.t === 'gatewayReady') throw new Error('port closed');
      },
      terminate: async () => 1,
    });
    const t = thread({ spawn: () => broken as never });
    const starting = t.start();
    broken.emit('message', { t: 'ready' } satisfies FromWorker);
    await starting;
    expect(() => t.setGatewayReady(false)).not.toThrow();
    expect(posts).toBe(1);
    const voiceAdapterCreator = () => ({
      sendPayload: () => true,
      destroy: () => {
        throw new Error('already gone');
      },
    });
    const joining = t.factory()({ id: 'voice-1', guild: { id: 'g3', voiceAdapterCreator } } as never);
    await vi.waitFor(() => expect(posts).toBe(2));
    broken.emit('message', { t: 'adapterOpen', adapterId: 1, guildId: 'g3' } satisfies FromWorker);
    broken.emit('exit', 1);
    await expect(joining).rejects.toMatchObject({ code: 'VOICE_CONNECT_TIMEOUT' });
  });

  it('restarts after about a second by default, and ignores the old worker’s gateway afterwards', async () => {
    const h = harness();
    const t = new VoiceThread({ logger: silentLogger(), spawn: h.spawn });
    threads.push(t);
    await t.start();
    const a = channel('g1');
    await t.factory()(a.channel);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    // A worker whose terminate fails is let go all the same.
    const first = h.workers[0]!;
    const terminate = first.terminate;
    first.terminate = async () => {
      await terminate();
      throw new Error('already gone');
    };
    h.workers[0]!.emit('exit', 1);
    // Updates for the old worker's adapter go nowhere.
    a.gateway.methods.onVoiceServerUpdate({ token: 'voice-token', guild_id: 'g1', endpoint: null });
    await vi.advanceTimersByTimeAsync(700);
    expect(h.workers).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(700);
    expect(h.workers).toHaveLength(2);
    vi.useRealTimers();
    await vi.waitFor(() => expect(t.alive).toBe(true));
    expect(h.library[0]!.server).toEqual([]);
  });

  it('lets go of a worker that stops by itself while it is being stopped', async () => {
    const quitter = Object.assign(new EventEmitter(), {
      postMessage(msg: ToWorker) {
        if (msg.t === 'shutdown') queueMicrotask(() => quitter.emit('exit', 0));
      },
      terminate: async () => 0,
    });
    const t = thread({ spawn: () => quitter as never });
    const starting = t.start();
    quitter.emit('message', { t: 'ready' } satisfies FromWorker);
    await starting;
    await t.stop();
    expect(t.alive).toBe(false);
  });

  it('stops a join that is waiting for a worker', async () => {
    const t = thread({
      spawn: () => Object.assign(new EventEmitter(), { postMessage() {}, terminate: async () => 1 }) as never,
    });
    const starting = t.start().catch((e: unknown) => e);
    const joining = t
      .factory()(channel().channel)
      .catch((e: unknown) => e);
    await t.stop();
    expect(await starting).toMatchObject({ message: 'The voice thread has been stopped.' });
    expect(await joining).toMatchObject({ code: 'VOICE_CONNECT_TIMEOUT' });
  });
});

describe('VoiceThread: health', () => {
  it('reports the worker’s event-loop delay, heap and garbage collection', async () => {
    const h = harness();
    const t = thread(h);
    expect(t.stats()).toBeNull();
    await t.start();
    await vi.waitFor(() => expect(t.stats()).not.toBeNull());
    expect(t.stats()).toMatchObject({
      alive: true,
      restarts: 0,
      links: 0,
      heapUsedMb: 12,
      loopDelay: { current: { maxMs: 2, p99Ms: 1 } },
      gc: { current: { maxMs: 0.5 } },
    });
    expect(t.stats()!.ageMs).toBeGreaterThanOrEqual(0);
  });

  it('logs the worker’s lines through the main logger, and warns about a delayed window', async () => {
    const h = harness();
    const logger = silentLogger();
    const lines: string[] = [];
    const child = {
      debug: (_o: unknown, m: string) => lines.push(`debug ${m}`),
      info: (_o: unknown, m: string) => lines.push(`info ${m}`),
      warn: (_o: unknown, m: string) => lines.push(`warn ${m}`),
      error: (_o: unknown, m: string) => lines.push(`error ${m}`),
    };
    vi.spyOn(logger, 'child').mockReturnValue(child as never);
    const t = thread(h, { logger });
    await t.start();
    const worker = h.workers[0]!;
    worker.emit('message', {
      t: 'log',
      level: 'warn',
      msg: 'something odd',
      data: { n: 1 },
    } satisfies FromWorker);
    worker.emit('message', { t: 'log', level: 'info', msg: 'plain' } satisfies FromWorker);
    const window = (maxMs: number): FromWorker => ({
      t: 'telemetry',
      rotated: true,
      telemetry: {
        ...telemetrySample(0),
        loopDelay: { current: null, lastWindow: { meanMs: 1, p99Ms: 5, maxMs, windowSec: 60 } },
      },
    });
    worker.emit('message', window(80));
    worker.emit('message', window(3));
    expect(lines).toContain('warn something odd');
    expect(lines).toContain('info plain');
    expect(lines).toContain('warn the voice worker event loop was delayed; voice packets may have been late');
    expect(lines).toContain('debug voice worker event loop delay');
  });

  it('runs the self-test in the worker', async () => {
    const h = harness();
    const t = thread(h);
    await t.start();
    expect(await t.selfTest()).toEqual({ ok: true, daveProtocolVersion: 1, heapUsedMb: 10, error: null });
  });

  it('gives up on a self-test the worker never answers', async () => {
    const h = harness({ selfTest: undefined });
    const t = thread(h);
    await t.start();
    await expect(t.selfTest(20)).rejects.toThrow(/self-test/);
  });
});
