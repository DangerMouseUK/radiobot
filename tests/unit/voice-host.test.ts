import { EventEmitter } from 'node:events';
import { constants } from 'node:perf_hooks';
import type { PassThrough } from 'node:stream';
import { MessageChannel, type MessagePort } from 'node:worker_threads';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RadioError } from '../../src/shared/errors.ts';
import { AdapterRelay, markAdapterUnavailable } from '../../src/voice/worker/adapter-relay.ts';
import { VoiceHost, type VoiceHostDeps } from '../../src/voice/worker/host.ts';
import {
  deserializeError,
  type FromWorker,
  serializeError,
  type ToWorker,
} from '../../src/voice/worker/protocol.ts';
import { voiceSelfTest } from '../../src/voice/worker/self-test.ts';
import { type DelayHistogram, LoopTelemetry } from '../../src/voice/worker/telemetry.ts';

class FakeLink extends EventEmitter {
  channelId = 'voice-1';
  ready = true;
  played: PassThrough[] = [];
  playOptions: unknown[] = [];
  stopThrows = false;
  destroyed = false;
  play(stream: PassThrough, options?: unknown) {
    this.played.push(stream);
    this.playOptions.push(options);
  }
  stopAudio() {
    if (this.stopThrows) throw new Error('player gone');
  }
  playbackMs() {
    return 0;
  }
  playerStatus() {
    return 'idle';
  }
  encryption() {
    return 'none';
  }
  stats() {
    return {
      wsPingMs: null,
      endpoint: null,
      packetsPlayed: null,
      packetTiming: { late: 0, worstGapMs: null, recent: [] },
      silenceMs: null,
      encryptionMode: null,
      status: 'ready',
      live: null,
    };
  }
  detach() {}
  destroy() {
    this.destroyed = true;
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
}

const open: Array<{ host: VoiceHost; ports: MessagePort[] }> = [];

/** A host on one end of a MessageChannel; the test plays the main thread on the other. */
function host(deps: Partial<VoiceHostDeps> = {}) {
  const { port1, port2 } = new MessageChannel();
  const received: FromWorker[] = [];
  port1.on('message', (m: FromWorker) => received.push(m));
  const links: FakeLink[] = [];
  const h = new VoiceHost({
    port: port2 as never,
    connect: async () => {
      const link = new FakeLink();
      links.push(link);
      return link as never;
    },
    ...deps,
  });
  open.push({ host: h, ports: [port1, port2] });
  const send = (m: ToWorker) => port1.postMessage(m);
  const waitFor = async (pred: (m: FromWorker) => boolean) => {
    await vi.waitFor(() => expect(received.some(pred)).toBe(true));
    return received.find(pred)!;
  };
  return { h, received, links, send, waitFor };
}

afterEach(() => {
  for (const { host: h, ports } of open.splice(0)) {
    h.shutdown();
    for (const p of ports) p.close();
  }
});

describe('VoiceHost', () => {
  it('arms and disarms a link’s receiver report reader, and reads it only when asked', async () => {
    const t = host();
    t.send({ t: 'join', linkId: 1, guildId: 'g1', channelId: 'voice-1', timeoutMs: 1 });
    await t.waitFor((m) => m.t === 'joined');
    const link = t.links[0]!;
    t.send({ t: 'reports', linkId: 1, on: true });
    t.send({ t: 'reports', linkId: 9, on: true }); // a link it doesn't have: dropped
    t.send({ t: 'readReport', linkId: 1, requestId: 7 });
    const answer = await t.waitFor((m) => m.t === 'report' && m.requestId === 7);
    expect(answer).toEqual({ t: 'report', linkId: 1, requestId: 7, reading: { state: 'waiting' } });
    // A link it doesn't have reads as off; a read that fails is reported, never thrown.
    t.send({ t: 'readReport', linkId: 9, requestId: 8 });
    expect(await t.waitFor((m) => m.t === 'report' && m.requestId === 8)).toMatchObject({
      reading: { state: 'off' },
    });
    link.readReport = async () => {
      throw new Error('cipher gone');
    };
    t.send({ t: 'readReport', linkId: 1, requestId: 9 });
    expect(await t.waitFor((m) => m.t === 'report' && m.requestId === 9)).toMatchObject({
      reading: { state: 'unreadable', reason: 'cipher gone' },
    });
    t.send({ t: 'reports', linkId: 1, on: false });
    await vi.waitFor(() => expect(link.reportCalls).toEqual(['arm', 'disarm']));
  });

  it('says it is ready, and joins with an adapter of its own for the guild', async () => {
    const targets: unknown[] = [];
    const t = host({
      connect: async (target, timeoutMs) => {
        targets.push({ ...target, timeoutMs });
        return new FakeLink() as never;
      },
    });
    await t.waitFor((m) => m.t === 'ready');
    t.send({ t: 'join', linkId: 1, guildId: 'g1', channelId: 'voice-1', timeoutMs: 20_000 });
    await t.waitFor((m) => m.t === 'joined');
    expect(targets).toEqual([
      { guildId: 'g1', channelId: 'voice-1', adapterCreator: expect.any(Function), timeoutMs: 20_000 },
    ]);
  });

  it('ignores audio for a stream or a link that is not current', async () => {
    const t = host();
    t.send({ t: 'join', linkId: 1, guildId: 'g1', channelId: 'voice-1', timeoutMs: 1 });
    await t.waitFor((m) => m.t === 'joined');
    t.send({ t: 'play', linkId: 1, streamId: 5 });
    t.send({ t: 'play', linkId: 9, streamId: 6 });
    await vi.waitFor(() => expect(t.links[0]!.played).toHaveLength(1));
    const pass = t.links[0]!.played[0]!;
    const got: Buffer[] = [];
    pass.on('data', (c: Buffer) => got.push(c));
    t.send({ t: 'audio', linkId: 1, streamId: 4, chunk: new Uint8Array([1]) });
    t.send({ t: 'audio', linkId: 2, streamId: 5, chunk: new Uint8Array([2]) });
    t.send({ t: 'audioEnd', linkId: 1, streamId: 4, how: 'end' });
    t.send({ t: 'audio', linkId: 1, streamId: 5, chunk: new Uint8Array([3]) });
    t.send({ t: 'audioEnd', linkId: 1, streamId: 5, how: 'end' });
    t.send({ t: 'audio', linkId: 1, streamId: 5, chunk: new Uint8Array([4]) });
    await vi.waitFor(() => expect(pass.destroyed).toBe(true));
    expect(pass.readableEnded).toBe(true);
    expect(Buffer.concat(got)).toEqual(Buffer.from([3]));
    // Already over: a late close changes nothing.
    t.send({ t: 'audioEnd', linkId: 1, streamId: 5, how: 'close' });
    // Messages for links it doesn't have are dropped quietly (and in order: the join comes after).
    t.send({ t: 'stopAudio', linkId: 9 });
    t.send({ t: 'detach', linkId: 9 });
    t.send({ t: 'join', linkId: 2, guildId: 'g1', channelId: 'voice-1', timeoutMs: 1 });
    await t.waitFor((m) => m.t === 'joined' && m.linkId === 2);
    expect(t.received.some((m) => m.t === 'log')).toBe(false);
  });

  it('reports an end of audio with no stream as stream 0, and one snapshot for a burst of changes', async () => {
    const t = host();
    t.send({ t: 'join', linkId: 1, guildId: 'g1', channelId: 'voice-1', timeoutMs: 1 });
    await t.waitFor((m) => m.t === 'joined');
    const link = t.links[0]!;
    link.emit('audioEnded', null);
    await t.waitFor((m) => m.t === 'audioEnded' && m.streamId === 0);
    link.emit('changed');
    link.emit('changed');
    link.emit('changed');
    await t.waitFor((m) => m.t === 'snapshot');
    await new Promise((r) => setTimeout(r, 10));
    expect(t.received.filter((m) => m.t === 'snapshot')).toHaveLength(1);
  });

  it('joins with the real voice library by default, relaying its gateway payloads (no network)', async () => {
    const t = host({ connect: undefined });
    t.send({
      t: 'join',
      linkId: 1,
      guildId: '123456789012345678',
      channelId: '223456789012345678',
      timeoutMs: 50,
    });
    const failed = await t.waitFor((m) => m.t === 'joinFailed');
    expect(failed).toMatchObject({ error: { code: 'VOICE_CONNECT_TIMEOUT' } });
    const types = t.received.map((m) => m.t);
    expect(types).toEqual(expect.arrayContaining(['adapterOpen', 'send', 'adapterClose']));
    expect(t.received.find((m) => m.t === 'send')).toMatchObject({
      payload: { op: 4, d: { channel_id: '223456789012345678', self_deaf: true } },
    });
  });

  it('fails the player’s stream the way the encoder output failed', async () => {
    const t = host();
    t.send({ t: 'join', linkId: 1, guildId: 'g1', channelId: 'voice-1', timeoutMs: 1 });
    await t.waitFor((m) => m.t === 'joined');
    t.send({ t: 'play', linkId: 1, streamId: 1 });
    await vi.waitFor(() => expect(t.links[0]!.played).toHaveLength(1));
    const first = t.links[0]!.played[0]!;
    const errors: Error[] = [];
    first.on('error', (e) => errors.push(e));
    t.send({ t: 'audioEnd', linkId: 1, streamId: 1, how: 'error', message: 'encoder output failed' });
    await vi.waitFor(() => expect(first.destroyed).toBe(true));
    expect(errors.map((e) => e.message)).toEqual(['encoder output failed']);
    // Closed early, without an error.
    t.send({ t: 'play', linkId: 1, streamId: 2 });
    await vi.waitFor(() => expect(t.links[0]!.played).toHaveLength(2));
    const second = t.links[0]!.played[1]!;
    t.send({ t: 'audioEnd', linkId: 1, streamId: 2, how: 'close' });
    await vi.waitFor(() => expect(second.destroyed).toBe(true));
    // An error without a message still fails the stream; a new stream replaces the old one.
    t.send({ t: 'play', linkId: 1, streamId: 3 });
    await vi.waitFor(() => expect(t.links[0]!.played).toHaveLength(3));
    const third = t.links[0]!.played[2]!;
    t.send({ t: 'play', linkId: 1, streamId: 4 });
    await vi.waitFor(() => expect(third.destroyed).toBe(true));
    t.send({ t: 'audioEnd', linkId: 1, streamId: 4, how: 'error' });
    await vi.waitFor(() => expect(t.links[0]!.played[3]!.destroyed).toBe(true));
  });

  it('plays each stream through the link with the cushion asked for, and relays its catch-ups', async () => {
    const t = host();
    t.send({ t: 'join', linkId: 1, guildId: 'g1', channelId: 'voice-1', timeoutMs: 1 });
    await t.waitFor((m) => m.t === 'joined');
    const link = t.links[0]!;
    const event = { reason: 'gap' as const, droppedMs: 400, cushionMs: 1_500 };
    // Before any stream: reported as stream 0, which the main thread ignores.
    link.emit('caughtUp', event);
    await t.waitFor((m) => m.t === 'caughtUp' && m.streamId === 0);
    t.send({ t: 'play', linkId: 1, streamId: 7, chunkMs: 6_000 });
    t.send({ t: 'play', linkId: 1, streamId: 8 });
    await vi.waitFor(() => expect(link.playOptions).toEqual([{ chunkMs: 6_000 }, undefined]));
    link.emit('caughtUp', event);
    expect(await t.waitFor((m) => m.t === 'caughtUp' && m.streamId === 8)).toEqual({
      t: 'caughtUp',
      linkId: 1,
      streamId: 8,
      event,
    });
  });

  it('keeps going, and says so, when one message cannot be handled', async () => {
    const t = host();
    t.send({ t: 'join', linkId: 1, guildId: 'g1', channelId: 'voice-1', timeoutMs: 1 });
    await t.waitFor((m) => m.t === 'joined');
    t.links[0]!.stopThrows = true;
    t.send({ t: 'stopAudio', linkId: 1 });
    const log = await t.waitFor((m) => m.t === 'log');
    expect(log).toMatchObject({
      level: 'error',
      msg: 'voice worker could not handle a message',
      data: { type: 'stopAudio', err: { message: 'player gone' } },
    });
    t.h.log('debug', 'no data');
    await t.waitFor((m) => m.t === 'log' && m.msg === 'no data' && !('data' in m));
  });

  it('pushes every link’s figures regularly, and telemetry with its windows', async () => {
    let rotations = 0;
    const t = host({
      snapshotIntervalMs: 10,
      telemetryIntervalMs: 10,
      telemetryWindowMs: 30,
      telemetry: {
        sample: (links) => ({
          loopDelay: { current: null, lastWindow: null },
          gc: { current: { count: 0, major: 0, maxMs: 0, totalMs: 0 }, lastWindow: null },
          heapUsedMb: 1,
          heapTotalMb: 2,
          externalMb: 0,
          arrayBuffersMb: 0,
          links,
          at: 0,
        }),
        rotate: () => rotations++,
        stop: () => {},
      },
    });
    t.send({ t: 'join', linkId: 3, guildId: 'g1', channelId: 'voice-1', timeoutMs: 1 });
    const snaps = await t.waitFor((m) => m.t === 'snapshots');
    expect(snaps).toMatchObject({
      t: 'snapshots',
      links: [[3, { channelId: 'voice-1', ready: true, streamId: 0 }]],
    });
    await t.waitFor((m) => m.t === 'telemetry' && m.rotated === true);
    await t.waitFor((m) => m.t === 'telemetry' && m.rotated === false && m.telemetry.links === 1);
    expect(rotations).toBeGreaterThan(0);
  });

  it('does not keep a link that joins while it shuts down, and says goodbye once', async () => {
    let finish: (l: FakeLink) => void = () => {};
    const link = new FakeLink();
    const t = host({ connect: () => new Promise((r) => (finish = r as never)) as never });
    t.send({ t: 'join', linkId: 1, guildId: 'g1', channelId: 'voice-1', timeoutMs: 1 });
    t.send({ t: 'selfTest' }); // no self-test here: no answer
    t.send({ t: 'shutdown' });
    await t.waitFor((m) => m.t === 'bye');
    finish(link);
    const failed = await t.waitFor((m) => m.t === 'joinFailed');
    expect(failed).toMatchObject({ error: { message: 'The voice worker is stopping.' } });
    expect(link.destroyed).toBe(true);
    t.h.shutdown();
    expect(t.received.filter((m) => m.t === 'bye')).toHaveLength(1);
    expect(t.received.some((m) => m.t === 'selfTest')).toBe(false);
  });
});

describe('AdapterRelay', () => {
  it('ignores updates for an adapter that has closed', () => {
    const posted: FromWorker[] = [];
    const marked: string[] = [];
    const relay = new AdapterRelay(
      (m) => posted.push(m),
      (g) => marked.push(g),
    );
    const seen: unknown[] = [];
    const implementer = relay.creatorFor('g1')({
      onVoiceServerUpdate: (d) => seen.push(d),
      onVoiceStateUpdate: (d) => seen.push(d),
      destroy: () => seen.push('destroy'),
    });
    expect(relay.size).toBe(1);
    implementer.destroy();
    relay.gateway(1, 'server', { token: 'x' });
    relay.destroyed(1);
    relay.sendFailed(1);
    expect(seen).toEqual([]);
    expect(marked).toEqual([]);
    expect(posted).toEqual([
      { t: 'adapterOpen', adapterId: 1, guildId: 'g1' },
      { t: 'adapterClose', adapterId: 1 },
    ]);
  });

  it('marks the connection unavailable the way the library does, unless it is gone', () => {
    const connection = { state: { status: 'signalling', adapter: {} } as Record<string, unknown> };
    markAdapterUnavailable('g1', () => connection as never);
    expect(connection.state).toEqual({ status: 'disconnected', reason: 1, adapter: {} });
    const destroyed = { state: { status: 'destroyed' } };
    markAdapterUnavailable('g1', () => destroyed as never);
    expect(destroyed.state).toEqual({ status: 'destroyed' });
    expect(() => markAdapterUnavailable('g1', () => undefined)).not.toThrow();
    // By default it looks the guild's connection up in the library (there is none here).
    expect(() => markAdapterUnavailable('no-such-guild')).not.toThrow();
  });
});

/** A delay histogram with fixed readings, in ns. */
function histogram(values: { count: number; mean: number; max: number; p99: number }): DelayHistogram & {
  resets: number;
  enabled: boolean;
} {
  return {
    ...values,
    resets: 0,
    enabled: false,
    percentile: () => values.p99,
    reset() {
      this.resets++;
    },
    enable() {
      this.enabled = true;
      return true;
    },
    disable() {
      this.enabled = false;
      return true;
    },
  };
}

describe('LoopTelemetry', () => {
  it('reports the worker’s loop delay and GC pauses per window', () => {
    let now = 1_000;
    const h = histogram({ count: 0, mean: 11e6, max: 40e6, p99: 25e6 });
    const t = new LoopTelemetry({ histogram: h, now: () => now, observeGc: false });
    expect(h.enabled).toBe(true);
    expect(t.sample(0).loopDelay).toEqual({ current: null, lastWindow: null });
    (h as { count: number }).count = 100;
    now += 30_000;
    t.recordGc(1.24, constants.NODE_PERFORMANCE_GC_MINOR);
    t.recordGc(6.56, constants.NODE_PERFORMANCE_GC_MAJOR);
    const s = t.sample(2);
    expect(s.loopDelay.current).toEqual({ meanMs: 1, p99Ms: 15, maxMs: 30, windowSec: 30 });
    expect(s.gc.current).toEqual({ count: 2, major: 1, maxMs: 6.6, totalMs: 7.8 });
    expect(s).toMatchObject({ links: 2, at: now });
    expect(s.heapUsedMb).toBeGreaterThan(0);
    t.rotate();
    expect(h.resets).toBe(1);
    const after = t.sample(2);
    expect(after.loopDelay.lastWindow).toEqual({ meanMs: 1, p99Ms: 15, maxMs: 30, windowSec: 30 });
    expect(after.gc).toEqual({
      current: { count: 0, major: 0, maxMs: 0, totalMs: 0 },
      lastWindow: { count: 2, major: 1, maxMs: 6.6, totalMs: 7.8 },
    });
    t.stop();
    expect(h.enabled).toBe(false);
  });

  it('watches the real event loop and garbage collector by default', async () => {
    const t = new LoopTelemetry();
    // Short-lived garbage: the young generation is collected, and the observer sees it.
    let keep: unknown[] = [];
    await vi.waitFor(() => {
      for (let i = 0; i < 200_000; i++) keep.push({ i });
      keep = [];
      expect(t.sample(0).gc.current.count).toBeGreaterThan(0);
    });
    t.stop();
    t.stop();
  });
});

describe('voice worker self-test', () => {
  it('creates a DAVE session with the native library, without any network', () => {
    const r = voiceSelfTest();
    expect(r).toMatchObject({ ok: true, error: null });
    expect(r.daveProtocolVersion).toBeGreaterThan(0);
  });

  it('reports a library that cannot create a session', () => {
    expect(
      voiceSelfTest(() => {
        throw new Error('no native binding');
      }),
    ).toMatchObject({ ok: false, daveProtocolVersion: null, error: 'no native binding' });
    expect(
      voiceSelfTest(() => {
        throw 'odd';
      }),
    ).toMatchObject({ ok: false, error: 'odd' });
  });
});

describe('worker messages', () => {
  it('carries errors across, a RadioError with its code', () => {
    const radio = deserializeError(serializeError(new RadioError('VOICE_CONNECT_TIMEOUT', 'Too slow.')));
    expect(radio).toBeInstanceOf(RadioError);
    expect(radio).toMatchObject({ code: 'VOICE_CONNECT_TIMEOUT', userMessage: 'Too slow.' });
    const plain = new TypeError('bad');
    expect(deserializeError(serializeError(plain))).toMatchObject({ name: 'TypeError', message: 'bad' });
    expect(serializeError(42)).toEqual({ name: 'Error', message: '42' });
  });
});
