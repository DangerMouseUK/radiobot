import type { Station } from '../catalogue/types.ts';
import { type Logger, safeErr } from '../observability/logger.ts';
import { truncate } from '../shared/text.ts';
import type { SessionStatus } from '../voice/session.ts';
import { isAudioActive } from '../voice/state-machine.ts';
import { clean } from './presence.ts';

/** Discord's limit for a voice channel status. */
const MAX_STATUS = 500;

/**
 * After a failed request, how many updates a server's status waits at most before the next try:
 * none after the first failure, then 1, 3, 7 … doubling up to this (about 10 minutes at one update
 * every 20 s), so a channel that keeps refusing isn't asked every time.
 */
const MAX_RETRY_SKIPS = 31;

/**
 * The voice channel status for one server's session: the station and, when the stream sends
 * one, the song or show title. Empty clears the status. Unlike the bot's own Discord status,
 * this is seen only in that server, so a server's custom station can be named.
 */
export function voiceStatusText(status: SessionStatus, station: Station | null): string {
  if (!isAudioActive(status.state) || !station) return '';
  const name = clean(station.displayName) ?? '';
  if (!name) return '';
  const track = clean(status.nowPlaying?.title ?? null);
  const text = track && track.toLowerCase() !== name.toLowerCase() ? `📻 ${name} · ${track}` : `📻 ${name}`;
  return truncate(text, MAX_STATUS);
}

export interface VoiceStatusDeps {
  /** Live session statuses, one per server with a session. */
  sessions: () => SessionStatus[];
  station: (id: string) => Station | null;
  /** The server's "Voice channel status" setting. */
  enabled: (guildId: string) => boolean;
  /** Whether the bot holds Set Voice Channel Status in that channel. */
  allowed: (guildId: string, channelId: string) => boolean;
  /** Sets the channel's status; an empty string clears it. */
  send: (channelId: string, status: string) => Promise<void>;
  logger: Logger;
}

/**
 * Shows what each server is playing as the status of the bot's voice channel. `update()` runs
 * on a timer and sends only changes. The permission is optional: where the bot lacks it, or
 * the setting is off, nothing is sent. A failed request (for example one sent while the bot is
 * still joining the channel) isn't remembered as sent: a later update tries again, backing off
 * per server (`MAX_RETRY_SKIPS`). Only the first failure in a row is logged as a warning, and none
 * is shown to users.
 */
export class VoiceStatusUpdater {
  readonly #d: VoiceStatusDeps;
  readonly #log: Logger;
  /**
   * What each server's channel was last set to. `text` is null when the last request failed: what
   * the channel shows isn't known, so the next update sends again, and leaving clears it.
   */
  readonly #sent = new Map<string, { channelId: string; text: string | null }>();
  /** Servers whose last request failed: failures in a row, and updates still to wait before the next try. */
  readonly #retry = new Map<string, { failures: number; skip: number }>();
  /**
   * Counts each server's `clear()` calls. `#update()` works from a snapshot and waits for each
   * request in turn, so a server that left meanwhile must not get a status set after its clear.
   */
  readonly #cleared = new Map<string, number>();

  constructor(deps: VoiceStatusDeps) {
    this.#d = deps;
    this.#log = deps.logger.child({ component: 'voice-status' });
  }

  #running = false;

  async update(): Promise<void> {
    if (this.#running) return; // a slow request must not let two runs overlap
    this.#running = true;
    try {
      await this.#update();
    } finally {
      this.#running = false;
    }
  }

  /** Clears every status the bot set, before it shuts down (best effort). */
  async clearAll(): Promise<void> {
    await Promise.all([...this.#sent].map(([guildId, last]) => this.clear(guildId, last.channelId)));
  }

  async #update(): Promise<void> {
    const seen = new Set<string>();
    const sessions = this.#d.sessions();
    const generation = new Map(sessions.map((st) => [st.guildId, this.#cleared.get(st.guildId) ?? 0]));
    const stale = (guildId: string) => (this.#cleared.get(guildId) ?? 0) !== generation.get(guildId);
    for (const st of sessions) {
      if (!st.channelId) continue;
      seen.add(st.guildId);
      if (stale(st.guildId)) continue;
      const want =
        this.#d.enabled(st.guildId) && st.stationId ? voiceStatusText(st, this.#d.station(st.stationId)) : '';
      const last = this.#sent.get(st.guildId);
      // The bot moved: clear the channel it left before setting the new one.
      if (last && last.channelId !== st.channelId) await this.#clear(st.guildId, last.channelId);
      const prev = this.#sent.get(st.guildId);
      if (prev?.text === want || (!prev && want === '')) continue;
      if (this.#backingOff(st.guildId)) continue;
      // The bot may have left this channel while the requests before this one were sent.
      if (stale(st.guildId)) continue;
      await this.#set(st.guildId, st.channelId, want);
    }
    // Sessions that left their channel: Discord may refuse once the bot is gone, which is fine.
    for (const [guildId, last] of this.#sent) {
      if (!seen.has(guildId)) await this.#clear(guildId, last.channelId);
    }
  }

  /** Clears the status the bot set in a channel it is about to leave (best effort). */
  async clear(guildId: string, channelId: string): Promise<void> {
    // Even with nothing set yet: an update already under way must not set one after this.
    this.#cleared.set(guildId, (this.#cleared.get(guildId) ?? 0) + 1);
    await this.#clear(guildId, channelId);
  }

  /** True while a server waits after a failed request; each call counts one update off the wait. */
  #backingOff(guildId: string): boolean {
    const retry = this.#retry.get(guildId);
    if (!retry || retry.skip === 0) return false;
    retry.skip--;
    return true;
  }

  async #clear(guildId: string, channelId: string): Promise<void> {
    const last = this.#sent.get(guildId);
    if (!last || last.channelId !== channelId) return;
    this.#sent.delete(guildId);
    this.#retry.delete(guildId);
    // Nothing to clear, or no longer allowed to (for example, the bot was removed from the server).
    if (last.text === '' || !this.#d.allowed(guildId, channelId)) return;
    try {
      await this.#d.send(channelId, '');
    } catch (err) {
      this.#log.debug({ guildId, err: safeErr(err) }, 'could not clear the voice channel status');
    }
  }

  async #set(guildId: string, channelId: string, text: string): Promise<void> {
    if (!this.#d.allowed(guildId, channelId)) {
      // Without the permission there is nothing to set, and nothing of ours to clear.
      this.#sent.delete(guildId);
      this.#retry.delete(guildId);
      return;
    }
    // Set before sending, so a clear() while the request waits sees it (and an update overlapping
    // this one doesn't send it twice).
    const entry: { channelId: string; text: string | null } = { channelId, text };
    this.#sent.set(guildId, entry);
    try {
      await this.#d.send(channelId, text);
      this.#retry.delete(guildId);
      this.#log.debug({ guildId, text }, 'voice channel status sent');
    } catch (err) {
      // The server left meanwhile (its entry is gone): nothing to try again.
      if (this.#sent.get(guildId) !== entry) return;
      entry.text = null;
      const failures = (this.#retry.get(guildId)?.failures ?? 0) + 1;
      this.#retry.set(guildId, { failures, skip: Math.min(2 ** (failures - 1), MAX_RETRY_SKIPS + 1) - 1 });
      const info = { guildId, failures, err: safeErr(err) };
      if (failures === 1) this.#log.warn(info, 'could not set the voice channel status; will try again');
      else this.#log.debug(info, 'could not set the voice channel status; will try again');
    }
  }
}
