import { describe, expect, it } from 'vitest';
import type { Station } from '../../src/catalogue/types.ts';
import {
  type PresenceEntry,
  PresenceUpdater,
  presenceEntries,
  presenceText,
} from '../../src/discord/presence.ts';
import type { SessionStatus } from '../../src/voice/session.ts';
import { silentLogger } from '../helpers.ts';

const shared = (name: string, track: string | null = null): PresenceEntry => ({ stationName: name, track });
const custom: PresenceEntry = { stationName: null, track: null };

describe('bot status text', () => {
  it('shows nothing when switched off or when nothing is playing', () => {
    expect(presenceText([shared('Demo Radio', 'Artist - Title')], 'off')).toBeNull();
    expect(presenceText([], 'track')).toBeNull();
  });

  it('names the station and track for one server', () => {
    expect(presenceText([shared('Demo Radio', 'Artist - Title')], 'track')).toBe(
      'Demo Radio · Artist - Title',
    );
    expect(presenceText([shared('Demo Radio')], 'track')).toBe('Demo Radio');
  });

  it('names only the station in station mode, or when the track is just the station name', () => {
    expect(presenceText([shared('Demo Radio', 'Artist - Title')], 'station')).toBe('Demo Radio');
    expect(presenceText([shared('Demo Radio', 'demo radio')], 'track')).toBe('Demo Radio');
  });

  it('never names a custom station, which is private to its server', () => {
    expect(presenceText([custom], 'track')).toBe('radio');
    expect(presenceText([custom, shared('Demo Radio')], 'track')).toBe('radio in 2 servers');
  });

  it('counts servers, naming the station only when they all play the same one', () => {
    expect(presenceText([shared('Demo Radio', 'A'), shared('Demo Radio', 'B')], 'track')).toBe(
      'Demo Radio in 2 servers',
    );
    expect(presenceText([shared('Demo Radio'), shared('Demo Chic'), shared('Demo Chic')], 'track')).toBe(
      'radio in 3 servers',
    );
  });

  it('flattens stream metadata to one line and fits Discord’s 128-character limit', () => {
    expect(presenceText([shared('Demo Radio', ' Artist\n\t-​Title\u0007 ')], 'track')).toBe(
      'Demo Radio · Artist - Title',
    );
    expect(presenceText([shared('Demo Radio', '   ')], 'track')).toBe('Demo Radio');
    const long = presenceText([shared('Demo Radio', 'x'.repeat(300))], 'track')!;
    expect(long).toHaveLength(128);
    expect(long.endsWith('…')).toBe(true);
  });
});

describe('bot status entries', () => {
  const station = (id: string, guildId: string | null) =>
    ({ id, guildId, displayName: id === 'demo:dj' ? 'Demo Radio' : 'My Station' }) as Station;
  const stations: Record<string, Station> = {
    'demo:dj': station('demo:dj', null),
    'custom:mine': station('custom:mine', '123456789012345678'),
  };
  const status = (o: Partial<SessionStatus>) =>
    ({ state: 'PLAYING', stationId: 'demo:dj', nowPlaying: null, ...o }) as SessionStatus;
  const meta = (title: string) => ({ title, receivedAt: '', source: 'icy-stream-title' as const });

  it('lists only servers playing audio, hiding custom and unknown stations', () => {
    const entries = presenceEntries(
      [
        status({ nowPlaying: meta('Artist - Title') }),
        status({ state: 'BUFFERING' }),
        status({ state: 'IDLE' }),
        status({ state: 'CONNECTED' }),
        status({ stationId: null }),
        status({ stationId: 'custom:mine', nowPlaying: meta('Private') }),
        status({ stationId: 'gone:station' }),
      ],
      (id) => stations[id] ?? null,
    );
    expect(entries).toEqual([
      { stationName: 'Demo Radio', track: 'Artist - Title' },
      { stationName: 'Demo Radio', track: null },
      { stationName: null, track: null },
      { stationName: null, track: null },
    ]);
  });
});

describe('bot status updater', () => {
  const setup = (mode: 'track' | 'station' | 'off' = 'track') => {
    let entries: PresenceEntry[] = [];
    let connected = true;
    const sent: (string | null)[] = [];
    const updater = new PresenceUpdater({
      mode,
      entries: () => entries,
      apply: (text) => {
        if (!connected) return false;
        sent.push(text);
        return true;
      },
      logger: silentLogger(),
    });
    return {
      updater,
      sent,
      play: (e: PresenceEntry[]) => {
        entries = e;
      },
      connect: (on: boolean) => {
        connected = on;
      },
    };
  };

  it('sends only changes', () => {
    const t = setup();
    t.updater.update();
    t.updater.update();
    t.play([shared('Demo Radio', 'A')]);
    t.updater.update();
    t.updater.update();
    t.play([shared('Demo Radio', 'B')]);
    t.updater.update();
    t.play([]);
    t.updater.update();
    expect(t.sent).toEqual([null, 'Demo Radio · A', 'Demo Radio · B', null]);
  });

  it('retries until Discord is connected, and resends after a new gateway session', () => {
    const t = setup();
    t.play([shared('Demo Radio')]);
    t.connect(false);
    t.updater.update();
    expect(t.sent).toEqual([]);
    t.connect(true);
    t.updater.update();
    t.updater.update();
    t.updater.invalidate();
    t.updater.update();
    expect(t.sent).toEqual(['Demo Radio', 'Demo Radio']);
  });

  it('never touches the status when switched off', () => {
    const t = setup('off');
    t.play([shared('Demo Radio')]);
    t.updater.update();
    t.updater.invalidate();
    t.updater.update();
    expect(t.sent).toEqual([]);
  });

  it('survives a failed update and tries again next time', () => {
    let fail = true;
    const sent: (string | null)[] = [];
    const updater = new PresenceUpdater({
      mode: 'station',
      entries: () => [shared('Demo Radio')],
      apply: (text) => {
        if (fail) throw new Error('gateway closed');
        sent.push(text);
        return true;
      },
      logger: silentLogger(),
    });
    expect(() => updater.update()).not.toThrow();
    fail = false;
    updater.update();
    expect(sent).toEqual(['Demo Radio']);
  });
});
