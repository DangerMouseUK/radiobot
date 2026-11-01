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
    expect(presenceText([shared('FG DJ RADIO', 'Artist - Title')], 'off')).toBeNull();
    expect(presenceText([], 'track')).toBeNull();
  });

  it('names the station and track for one server', () => {
    expect(presenceText([shared('FG DJ RADIO', 'Artist - Title')], 'track')).toBe(
      'FG DJ RADIO · Artist - Title',
    );
    expect(presenceText([shared('FG DJ RADIO')], 'track')).toBe('FG DJ RADIO');
  });

  it('names only the station in station mode, or when the track is just the station name', () => {
    expect(presenceText([shared('FG DJ RADIO', 'Artist - Title')], 'station')).toBe('FG DJ RADIO');
    expect(presenceText([shared('FG DJ RADIO', 'fg dj radio')], 'track')).toBe('FG DJ RADIO');
  });

  it('never names a custom station, which is private to its server', () => {
    expect(presenceText([custom], 'track')).toBe('radio');
    expect(presenceText([custom, shared('FG DJ RADIO')], 'track')).toBe('radio in 2 servers');
  });

  it('counts servers, naming the station only when they all play the same one', () => {
    expect(presenceText([shared('FG DJ RADIO', 'A'), shared('FG DJ RADIO', 'B')], 'track')).toBe(
      'FG DJ RADIO in 2 servers',
    );
    expect(presenceText([shared('FG DJ RADIO'), shared('FG CHIC'), shared('FG CHIC')], 'track')).toBe(
      'radio in 3 servers',
    );
  });

  it('flattens stream metadata to one line and fits Discord’s 128-character limit', () => {
    expect(presenceText([shared('FG DJ RADIO', ' Artist\n\t-​Title\u0007 ')], 'track')).toBe(
      'FG DJ RADIO · Artist - Title',
    );
    expect(presenceText([shared('FG DJ RADIO', '   ')], 'track')).toBe('FG DJ RADIO');
    const long = presenceText([shared('FG DJ RADIO', 'x'.repeat(300))], 'track')!;
    expect(long).toHaveLength(128);
    expect(long.endsWith('…')).toBe(true);
  });
});

describe('bot status entries', () => {
  const station = (id: string, guildId: string | null) =>
    ({ id, guildId, displayName: id === 'fg:dj' ? 'FG DJ RADIO' : 'My Station' }) as Station;
  const stations: Record<string, Station> = {
    'fg:dj': station('fg:dj', null),
    'custom:mine': station('custom:mine', '123456789012345678'),
  };
  const status = (o: Partial<SessionStatus>) =>
    ({ state: 'PLAYING', stationId: 'fg:dj', nowPlaying: null, ...o }) as SessionStatus;
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
      { stationName: 'FG DJ RADIO', track: 'Artist - Title' },
      { stationName: 'FG DJ RADIO', track: null },
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
    t.play([shared('FG DJ RADIO', 'A')]);
    t.updater.update();
    t.updater.update();
    t.play([shared('FG DJ RADIO', 'B')]);
    t.updater.update();
    t.play([]);
    t.updater.update();
    expect(t.sent).toEqual([null, 'FG DJ RADIO · A', 'FG DJ RADIO · B', null]);
  });

  it('retries until Discord is connected, and resends after a new gateway session', () => {
    const t = setup();
    t.play([shared('FG DJ RADIO')]);
    t.connect(false);
    t.updater.update();
    expect(t.sent).toEqual([]);
    t.connect(true);
    t.updater.update();
    t.updater.update();
    t.updater.invalidate();
    t.updater.update();
    expect(t.sent).toEqual(['FG DJ RADIO', 'FG DJ RADIO']);
  });

  it('never touches the status when switched off', () => {
    const t = setup('off');
    t.play([shared('FG DJ RADIO')]);
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
      entries: () => [shared('FG DJ RADIO')],
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
    expect(sent).toEqual(['FG DJ RADIO']);
  });
});
