import { type Client, PermissionFlagsBits } from 'discord.js';
import type { Logger } from '../observability/logger.ts';
import type { GuildRepository } from '../persistence/repositories/guilds.ts';
import { truncate } from '../shared/text.ts';
import type { SessionNotice } from '../voice/session.ts';

const WINDOW_MS = 5 * 60_000;

/**
 * Sends concise recovery/error notices to a guild's configured notification channel,
 * coalescing repeats (PRD FR-008): the first notice of a kind is sent, later ones within
 * five minutes are counted and summarised once the window closes.
 */
export class Notifier {
  readonly #client: Client;
  readonly #guilds: GuildRepository;
  readonly #log: Logger;
  readonly #recent = new Map<
    string,
    { at: number; suppressed: number; last: SessionNotice; timer: NodeJS.Timeout | null }
  >();

  constructor(client: Client, guilds: GuildRepository, logger: Logger) {
    this.#client = client;
    this.#guilds = guilds;
    this.#log = logger.child({ component: 'notifier' });
  }

  notify = (notice: SessionNotice): void => {
    const key = `${notice.guildId}:${notice.kind}`;
    const now = Date.now();
    const prev = this.#recent.get(key);
    if (prev && now - prev.at < WINDOW_MS) {
      prev.suppressed++;
      prev.last = notice;
      prev.timer ??= setTimeout(() => this.#flush(key), WINDOW_MS - (now - prev.at));
      return;
    }
    this.#recent.set(key, { at: now, suppressed: 0, last: notice, timer: null });
    void this.#send(notice.guildId, notice.message);
    if (this.#recent.size > 1000) this.#sweep(now);
  };

  #flush(key: string): void {
    const entry = this.#recent.get(key);
    if (!entry) return;
    entry.timer = null;
    if (entry.suppressed > 0) {
      void this.#send(
        entry.last.guildId,
        `${entry.last.message} _(${entry.suppressed} similar notice${entry.suppressed === 1 ? '' : 's'} in the last 5 minutes)_`,
      );
    }
    this.#recent.delete(key);
  }

  #sweep(now: number): void {
    for (const [k, v] of this.#recent) if (now - v.at > WINDOW_MS && !v.timer) this.#recent.delete(k);
  }

  async #send(guildId: string, message: string): Promise<void> {
    const channelId = this.#guilds.getSettings(guildId).notificationChannelId;
    if (!channelId) return;
    try {
      const ch = await this.#client.channels.fetch(channelId);
      if (!ch?.isSendable() || !('guild' in ch) || ch.guild.id !== guildId) return;
      const me = ch.guild.members.me;
      if (me && 'permissionsFor' in ch && !ch.permissionsFor(me)?.has(PermissionFlagsBits.SendMessages))
        return;
      await ch.send({ content: truncate(`📻 ${message}`, 1900), allowedMentions: { parse: [] } });
    } catch (err) {
      this.#log.debug({ guildId, err: (err as Error).message }, 'notice not delivered');
    }
  }

  close(): void {
    for (const v of this.#recent.values()) if (v.timer) clearTimeout(v.timer);
    this.#recent.clear();
  }
}
