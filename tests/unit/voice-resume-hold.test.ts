import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The real @discordjs/voice audio player against a stand-in voice connection that behaves as the
 * library's own does: it is `connecting` while its voice WebSocket resumes, and a connection that
 * isn't ready sends nothing. Every frame carries its number, so the test sees exactly which frames
 * reach Discord.
 */
class FakeConnection extends EventEmitter {
  state: { status: string; networking?: { state: object } } = { status: 'ready' };
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

const { createAudioPlayer, createAudioResource, NoSubscriberBehavior, StreamType } = await import(
  '@discordjs/voice'
);
const { DiscordVoiceLink, VOICE_HOLD_MS } = await import('../../src/voice/link.ts');

/** 20 ms Opus frames numbered from 0, already demuxed, so the player reads them as they are. */
function frames(count: number) {
  const packets = Array.from({ length: count }, (_, i) => {
    const b = Buffer.alloc(4);
    b.writeUInt16BE(i, 0);
    return b;
  });
  return createAudioResource(Readable.from(packets, { objectMode: true }), { inputType: StreamType.Opus });
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
const resumed = (connection: FakeConnection) => connection.setState({ status: 'ready' });

/** Stops each player, so a failed test can't leave the library's shared audio cycle running. */
const cleanup: Array<() => void> = [];

afterEach(() => {
  for (const done of cleanup.splice(0)) done();
  vi.useRealTimers();
});

describe('a voice WebSocket resume during playback', () => {
  it('drops the frames read while it lasts, with the library alone (why the link holds)', async () => {
    vi.useFakeTimers();
    const connection = new FakeConnection();
    const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } });
    connection.subscribe(player);
    cleanup.push(() => player.stop(true));
    player.play(frames(200));
    await cycles(20);
    resume(connection);
    await cycles(6);
    resumed(connection);
    await cycles(20);
    // Six cycles without a ready connection: six frames read and thrown away.
    expect(missing(connection.sent)).toHaveLength(6);
  });

  it('loses nothing through the link: playback holds its place and plays on', async () => {
    vi.useFakeTimers();
    const connection = new FakeConnection();
    voice.connection = connection;
    const link = await DiscordVoiceLink.connect({
      guildId: 'g1',
      channelId: 'voice-1',
      adapterCreator: () => ({}) as never,
    });
    cleanup.push(() => link.destroy());
    link.player.play(frames(200));
    await cycles(20);
    resume(connection);
    await cycles(6);
    resumed(connection);
    await cycles(20);
    expect(connection.sent.length).toBeGreaterThan(30);
    expect(missing(connection.sent)).toEqual([]);
    expect(connection.sent).toEqual([...connection.sent].sort((a, b) => a - b));
  });

  it('goes back to dropping frames once the outage outlasts the hold', async () => {
    vi.useFakeTimers();
    const connection = new FakeConnection();
    voice.connection = connection;
    const link = await DiscordVoiceLink.connect({
      guildId: 'g1',
      channelId: 'voice-1',
      adapterCreator: () => ({}) as never,
    });
    cleanup.push(() => link.destroy());
    link.player.play(frames(500));
    await cycles(20);
    resume(connection);
    // The hold, then 10 more cycles while the connection is still away.
    await cycles(VOICE_HOLD_MS / 20 + 10);
    resumed(connection);
    await cycles(20);
    // Only the time beyond the hold is skipped (give or take the cycle the hold ended in).
    expect(missing(connection.sent).length).toBeGreaterThanOrEqual(9);
    expect(missing(connection.sent).length).toBeLessThanOrEqual(11);
  });
});
