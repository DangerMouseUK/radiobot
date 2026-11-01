import type { Station } from '../catalogue/types.ts';
import type { PresenceMode } from '../config/env.ts';
import { type Logger, safeErr } from '../observability/logger.ts';
import { truncate } from '../shared/text.ts';
import type { SessionStatus } from '../voice/session.ts';
import { isAudioActive } from '../voice/state-machine.ts';

/** Discord's limit for an activity name. */
const MAX_ACTIVITY = 128;

/** One server that is playing audio, as the bot's status may describe it. */
export interface PresenceEntry {
  /** Null for a server's own custom station: it is private to that server, so it is never named. */
  stationName: string | null;
  track: string | null;
}

/** The playing servers, from live session statuses. */
export function presenceEntries(
  statuses: readonly SessionStatus[],
  station: (id: string) => Station | null,
): PresenceEntry[] {
  const entries: PresenceEntry[] = [];
  for (const st of statuses) {
    if (!isAudioActive(st.state) || !st.stationId) continue;
    const s = station(st.stationId);
    const shared = s !== null && s.guildId === null;
    entries.push({
      stationName: shared ? s.displayName : null,
      track: shared ? (st.nowPlaying?.title ?? null) : null,
    });
  }
  return entries;
}

/** Stream metadata is shown as one plain line: no control characters or runs of whitespace. */
function clean(text: string | null): string | null {
  if (text === null) return null;
  const t = text
    .replace(/[\p{Cc}\p{Cf}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return t.length > 0 ? t : null;
}

/**
 * The text after "Listening to", or null for no activity. A bot has one status for every
 * server, so it names a station only when every playing server plays that same one.
 */
export function presenceText(entries: readonly PresenceEntry[], mode: PresenceMode): string | null {
  if (mode === 'off' || entries.length === 0) return null;
  const names = new Set(entries.map((e) => clean(e.stationName)));
  const name = names.size === 1 ? [...names][0]! : null;
  let text: string;
  if (name === null) {
    text = entries.length === 1 ? 'radio' : `radio in ${entries.length} servers`;
  } else if (entries.length > 1) {
    text = `${name} in ${entries.length} servers`;
  } else {
    const track = mode === 'track' ? clean(entries[0]!.track) : null;
    text = track && track.toLowerCase() !== name.toLowerCase() ? `${name} · ${track}` : name;
  }
  return truncate(text, MAX_ACTIVITY);
}

export interface PresenceDeps {
  mode: PresenceMode;
  /** The servers playing right now. */
  entries: () => PresenceEntry[];
  /** Sets the bot's "Listening to" activity, or clears it for null; false when not connected yet. */
  apply: (text: string | null) => boolean;
  logger: Logger;
}

/**
 * Keeps the bot's Discord status in step with what it plays. `update()` runs on a timer and
 * sends only real changes, which keeps well within Discord's limit on status updates.
 */
export class PresenceUpdater {
  readonly #d: PresenceDeps;
  readonly #log: Logger;
  /** What Discord was last sent; undefined when unknown (before the first update, or after a reconnect). */
  #last: string | null | undefined = undefined;

  constructor(deps: PresenceDeps) {
    this.#d = deps;
    this.#log = deps.logger.child({ component: 'presence' });
  }

  update(): void {
    if (this.#d.mode === 'off') return;
    const text = presenceText(this.#d.entries(), this.#d.mode);
    if (text === this.#last) return;
    try {
      if (this.#d.apply(text)) {
        this.#last = text;
        this.#log.debug({ text }, 'bot status sent');
      }
    } catch (err) {
      this.#log.warn({ err: safeErr(err) }, 'could not update the bot status');
    }
  }

  /** Forgets what was sent, so the next update sends it again (a new gateway session starts blank). */
  invalidate(): void {
    this.#last = undefined;
  }
}
