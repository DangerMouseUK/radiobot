import { describe, expect, it } from 'vitest';
import type { Station } from '../../src/catalogue/types.ts';
import { VoiceStatusUpdater, voiceStatusText } from '../../src/discord/voice-status.ts';
import type { SessionStatus } from '../../src/voice/session.ts';
import { silentLogger } from '../helpers.ts';

const station = (displayName: string, guildId: string | null = null) =>
  ({ id: 'x', displayName, guildId }) as Station;
const meta = (title: string) => ({ title, receivedAt: '', source: 'icy-stream-title' as const });
const status = (o: Partial<SessionStatus> = {}) =>
  ({
    guildId: 'g1',
    state: 'PLAYING',
    stationId: 'fg:fg-dj-radio',
    channelId: 'voice-1',
    nowPlaying: null,
    ...o,
  }) as SessionStatus;

describe('voice channel status text', () => {
  it('names the station and the song or show', () => {
    expect(voiceStatusText(status({ nowPlaying: meta('Artist - Title') }), station('FG DJ RADIO'))).toBe(
      '📻 FG DJ RADIO · Artist - Title',
    );
    expect(voiceStatusText(status(), station('FG DJ RADIO'))).toBe('📻 FG DJ RADIO');
    expect(voiceStatusText(status({ nowPlaying: meta('fg dj radio') }), station('FG DJ RADIO'))).toBe(
      '📻 FG DJ RADIO',
    );
  });

  it('may name a custom station, because only that server sees it', () => {
    expect(voiceStatusText(status(), station('Our Station', '123456789012345678'))).toBe('📻 Our Station');
  });

  it('is empty when nothing plays, and fits Discord’s 500-character limit', () => {
    expect(voiceStatusText(status({ state: 'CONNECTED' }), station('FG DJ RADIO'))).toBe('');
    expect(voiceStatusText(status(), null)).toBe('');
    const long = voiceStatusText(status({ nowPlaying: meta('x'.repeat(900)) }), station('FG DJ RADIO'));
    expect(long).toHaveLength(500);
  });
});

describe('voice channel status updater', () => {
  const setup = (o: { enabled?: boolean; allowed?: boolean; fail?: boolean } = {}) => {
    let sessions: SessionStatus[] = [];
    let enabled = o.enabled ?? true;
    let allowed = o.allowed ?? true;
    let fail = o.fail ?? false;
    const sent: Array<[string, string]> = [];
    const u = new VoiceStatusUpdater({
      sessions: () => sessions,
      station: () => station('FG DJ RADIO'),
      enabled: () => enabled,
      allowed: () => allowed,
      send: async (channelId, text) => {
        if (fail) throw new Error('Missing Permissions');
        sent.push([channelId, text]);
      },
      logger: silentLogger(),
    });
    return {
      u,
      sent,
      set: (s: SessionStatus[]) => {
        sessions = s;
      },
      enable: (v: boolean) => {
        enabled = v;
      },
      allow: (v: boolean) => {
        allowed = v;
      },
      failing: (v: boolean) => {
        fail = v;
      },
    };
  };

  it('sends only changes, and clears when playback stops', async () => {
    const t = setup();
    t.set([status({ nowPlaying: meta('A') })]);
    await t.u.update();
    await t.u.update();
    t.set([status({ nowPlaying: meta('B') })]);
    await t.u.update();
    t.set([status({ state: 'CONNECTED' })]);
    await t.u.update();
    await t.u.update();
    expect(t.sent).toEqual([
      ['voice-1', '📻 FG DJ RADIO · A'],
      ['voice-1', '📻 FG DJ RADIO · B'],
      ['voice-1', ''],
    ]);
  });

  it('never touches a channel when the setting is off or the permission is missing', async () => {
    for (const o of [{ enabled: false }, { allowed: false }]) {
      const t = setup(o);
      t.set([status({ nowPlaying: meta('A') })]);
      await t.u.update();
      t.set([status({ state: 'CONNECTED' })]);
      await t.u.update();
      expect(t.sent).toEqual([]);
    }
  });

  it('clears its status when the setting is switched off', async () => {
    const t = setup();
    t.set([status()]);
    await t.u.update();
    t.enable(false);
    await t.u.update();
    expect(t.sent).toEqual([
      ['voice-1', '📻 FG DJ RADIO'],
      ['voice-1', ''],
    ]);
  });

  it('clears the old channel when the bot moves, and when it leaves', async () => {
    const t = setup();
    t.set([status()]);
    await t.u.update();
    t.set([status({ channelId: 'voice-2' })]);
    await t.u.update();
    t.set([]);
    await t.u.update();
    expect(t.sent).toEqual([
      ['voice-1', '📻 FG DJ RADIO'],
      ['voice-1', ''],
      ['voice-2', '📻 FG DJ RADIO'],
      ['voice-2', ''],
    ]);
  });

  it('clears before leaving when asked, and only the channel it set', async () => {
    const t = setup();
    t.set([status()]);
    await t.u.update();
    await t.u.clear('g1', 'voice-other');
    await t.u.clear('g1', 'voice-1');
    await t.u.clear('g1', 'voice-1');
    expect(t.sent).toEqual([
      ['voice-1', '📻 FG DJ RADIO'],
      ['voice-1', ''],
    ]);
  });

  it('skips clearing a channel it may no longer touch, such as after being removed from the server', async () => {
    const t = setup();
    t.set([status()]);
    await t.u.update();
    t.allow(false);
    t.set([]);
    await t.u.update();
    expect(t.sent).toEqual([['voice-1', '📻 FG DJ RADIO']]);
  });

  it('does not retry a failed request in a loop', async () => {
    const t = setup({ fail: true });
    t.set([status()]);
    await t.u.update();
    await t.u.update();
    t.failing(false);
    await t.u.update();
    expect(t.sent).toEqual([]);
    t.set([status({ nowPlaying: meta('A') })]);
    await t.u.update();
    expect(t.sent).toEqual([['voice-1', '📻 FG DJ RADIO · A']]);
  });

  it('clears everything it set on shutdown', async () => {
    const t = setup();
    t.set([status(), status({ guildId: 'g2', channelId: 'voice-9' })]);
    await t.u.update();
    await t.u.clearAll();
    expect(
      t.sent
        .filter(([, text]) => text === '')
        .map(([c]) => c)
        .sort(),
    ).toEqual(['voice-1', 'voice-9']);
  });
});
