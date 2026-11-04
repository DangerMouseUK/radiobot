import { describe, expect, it, vi } from 'vitest';
import { VoiceThread } from '../../src/voice/voice-thread.ts';
import { silentLogger } from '../helpers.ts';

/**
 * A real voice worker, started from its module the way the bot starts it: @discordjs/voice and the
 * DAVE native library load in the worker thread. Nothing here reaches Discord or the network: the
 * gateway is a stand-in that records what the worker's voice library sends through it.
 */
function fakeChannel() {
  const sent: Array<{ op: number; d: Record<string, unknown> }> = [];
  let destroyed = 0;
  const voiceAdapterCreator = () => ({
    sendPayload: (p: { op: number; d: Record<string, unknown> }) => {
      sent.push(p);
      return true;
    },
    destroy: () => {
      destroyed++;
    },
  });
  return {
    channel: { id: '223456789012345678', guild: { id: '123456789012345678', voiceAdapterCreator } } as never,
    sent,
    destroyed: () => destroyed,
  };
}

describe('voice worker thread', () => {
  it('starts, loads the voice libraries and DAVE, joins through the relayed gateway, and stops cleanly, twice', async () => {
    for (let round = 0; round < 2; round++) {
      const voice = new VoiceThread({ logger: silentLogger(), joinTimeoutMs: 300 });
      try {
        await voice.start();
        expect(voice.alive).toBe(true);
        const test = await voice.selfTest();
        expect(test).toMatchObject({ ok: true, error: null });
        expect(test.daveProtocolVersion).toBeGreaterThan(0);
        expect(test.heapUsedMb).toBeGreaterThan(0);

        // The real library asks to join through the main thread's gateway, self-deafened. With no
        // voice server to answer, it gives up, leaves (through the gateway again) and lets go.
        const { channel, sent, destroyed } = fakeChannel();
        await expect(voice.factory()(channel)).rejects.toMatchObject({ code: 'VOICE_CONNECT_TIMEOUT' });
        await vi.waitFor(() => expect(destroyed()).toBe(1));
        expect(sent[0]).toMatchObject({
          op: 4,
          d: {
            guild_id: '123456789012345678',
            channel_id: '223456789012345678',
            self_deaf: true,
            self_mute: false,
          },
        });
        expect(sent.at(-1)).toMatchObject({ op: 4, d: { channel_id: null } });
      } finally {
        await voice.stop();
      }
      expect(voice.alive).toBe(false);
    }
  });
});
