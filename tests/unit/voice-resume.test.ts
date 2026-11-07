import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The real @discordjs/voice audio player and the real live queue against a stand-in voice
 * connection that behaves as the library's own does: it is `connecting` while its voice WebSocket
 * resumes, and a connection that isn't ready sends nothing. Every frame carries its number, so the
 * test sees exactly which frames reach Discord.
 */
class FakeConnection extends EventEmitter {
  state: { status: string; networking?: { state: object } } = { status: 'ready', networking: { state: {} } };
  ping = { ws: 10 };
  joinConfig = { channelId: 'voice-1' };
  sent: number[] = [];
  #prepared: Buffer | undefined;
  subscribe(player: unknown) {
    return (player as { subscribe(connection: unknown): unknown }).subscribe(this);
  }
  prepareAudioPacket(packet: Buffer) {
    if (this.state.status !== 'ready') return;
    this.#prepared = packet;
  }
  dispatchAudio(): boolean {
    if (this.state.status !== 'ready' || !this.#prepared) return false;
    this.sent.push(this.#prepared.readUInt16BE(0));
    this.#prepared = undefined;
    return true;
  }
  setSpeaking() {}
  setState(state: FakeConnection['state']) {
    const old = this.state;
    this.state = state;
    this.emit('stateChange', old, state);
  }
  destroy() {
    this.setState({ status: 'destroyed' });
  }
}

const voice = vi.hoisted(() => ({ connection: null as unknown }));

vi.mock('@discordjs/voice', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@discordjs/voice')>();
  return { ...actual, joinVoiceChannel: () => voice.connection };
});

const { DiscordVoiceLink } = await import('../../src/voice/link.ts');
type Link = Awaited<ReturnType<typeof DiscordVoiceLink.connect>>;

/** One Ogg page carrying `packets`, one segment each (the demuxer doesn't check the CRC). */
function oggPage(packets: Buffer[]): Buffer {
  const header = Buffer.alloc(27);
  header.write('OggS', 0, 'latin1');
  header.writeUInt32LE(1, 14);
  header.writeUInt8(packets.length, 26);
  return Buffer.concat([header, Buffer.from(packets.map((p) => p.length)), ...packets]);
}

/**
 * A station as the encoder's output: the Ogg Opus headers, a connect burst, then one numbered
 * 20 ms frame per cycle.
 */
function station(burst: number) {
  const output = new PassThrough();
  let next = 0;
  const frames = (n: number) => {
    const packets = Array.from({ length: n }, () => {
      const b = Buffer.alloc(4);
      b.writeUInt16BE(next++, 0);
      return b;
    });
    for (let i = 0; i < packets.length; i += 50) output.write(oggPage(packets.slice(i, i + 50)));
  };
  output.write(oggPage([Buffer.concat([Buffer.from('OpusHead'), Buffer.alloc(11)])]));
  output.write(oggPage([Buffer.concat([Buffer.from('OpusTags'), Buffer.alloc(8)])]));
  frames(burst);
  const timer = setInterval(() => frames(1), 20);
  cleanup.push(() => clearInterval(timer));
  return { output, frames };
}

/** Runs the player's 20 ms cycle `n` times. */
const cycles = (n: number) => vi.advanceTimersByTimeAsync(20 * n);

/** The frame numbers that never reached Discord, between the first and the last one sent. */
function missing(sent: number[]): number[] {
  const out: number[] = [];
  for (let n = sent[0] ?? 0; n <= (sent[sent.length - 1] ?? -1); n++) if (!sent.includes(n)) out.push(n);
  return out;
}

const resume = (connection: FakeConnection) => connection.setState({ status: 'connecting' });
const resumed = (connection: FakeConnection) =>
  connection.setState({ status: 'ready', networking: { state: {} } });

/** Stops each player, so a failed test can't leave the library's shared audio cycle running. */
const cleanup: Array<() => void> = [];

afterEach(() => {
  for (const done of cleanup.splice(0)) done();
  vi.useRealTimers();
});

async function playing(burst = 75) {
  vi.useFakeTimers();
  const connection = new FakeConnection();
  voice.connection = connection;
  const link: Link = await DiscordVoiceLink.connect({
    guildId: 'g1',
    channelId: 'voice-1',
    adapterCreator: () => ({}) as never,
  });
  cleanup.push(() => link.destroy());
  const events = { restored: [] as unknown[], caughtUp: [] as unknown[] };
  link.on('restored', (info) => events.restored.push(info));
  link.on('caughtUp', (event) => events.caughtUp.push(event));
  const source = station(burst);
  link.play(source.output);
  await cycles(100);
  return { connection, link, source, events };
}

describe('a voice WebSocket resume during playback', () => {
  it('plays Opus packets out of the Ogg stream, at the cushion behind the newest', async () => {
    const { connection, link, events } = await playing();
    // The connect burst beyond the 1 s cushion went before anything was heard.
    expect(events.caughtUp).toEqual([expect.objectContaining({ reason: 'start', cushionMs: 1_000 })]);
    expect(connection.sent.length).toBeGreaterThan(30);
    expect(missing(connection.sent)).toEqual([]);
    expect(link.stats().live).toMatchObject({ cushionMs: 1_000, catchUps: 0, gaps: 0 });
    expect(link.stats().live!.depthMs).toBeGreaterThanOrEqual(960);
    expect(link.stats().live!.depthMs).toBeLessThanOrEqual(1_040);
  });

  it('reads and drops the audio while it lasts: playback stays live, nothing is held', async () => {
    const { connection, link, events } = await playing();
    resume(connection);
    await cycles(3);
    expect(link.playerStatus()).toBe('playing');
    await cycles(3);
    resumed(connection);
    await cycles(20);
    // Six cycles without a ready connection: six frames read and thrown away, and no more.
    expect(missing(connection.sent)).toHaveLength(6);
    expect(connection.sent).toEqual([...connection.sent].sort((a, b) => a - b));
    expect(events.restored).toEqual([{ afterMs: 120, skippedMs: 120, caughtUpMs: 0 }]);
    // Still a cushion behind the newest frame, as before the resume: no delay was added.
    expect(link.stats().live!.depthMs).toBeLessThanOrEqual(1_040);
  });

  it('drops a backlog that built up during the resume as it ends, where the gap hides it', async () => {
    const { connection, link, source, events } = await playing();
    resume(connection);
    await cycles(3);
    // The station's server sends what it held back.
    source.frames(15);
    await cycles(3);
    resumed(connection);
    const restore = events.restored[0] as { caughtUpMs: number };
    expect(restore).toMatchObject({ afterMs: 120, skippedMs: 120 });
    expect(restore.caughtUpMs).toBeGreaterThanOrEqual(280);
    expect(restore.caughtUpMs).toBeLessThanOrEqual(320);
    expect(events.caughtUp.at(-1)).toEqual({
      reason: 'resume',
      droppedMs: restore.caughtUpMs,
      cushionMs: 1_000,
    });
    await cycles(20);
    expect(missing(connection.sent)).toHaveLength(6 + restore.caughtUpMs / 20);
    expect(link.stats().live).toMatchObject({ catchUps: 1, caughtUpMs: restore.caughtUpMs });
    expect(link.stats().live!.depthMs).toBeLessThanOrEqual(1_040);
  });

  it('counts only the audio read while playing when Stop cuts the outage short', async () => {
    const { connection, link, events } = await playing();
    resume(connection);
    await cycles(15);
    link.stopAudio();
    expect(link.stats().live).toBeNull();
    await cycles(100);
    resumed(connection);
    expect(events.restored).toEqual([{ afterMs: 2_300, skippedMs: 300, caughtUpMs: 0 }]);
  });
});
