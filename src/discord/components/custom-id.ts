import { createHmac, timingSafeEqual } from 'node:crypto';

const PREFIX = 'rb1';
const SIG_LEN = 16;
const MAX_LEN = 100;

export interface ComponentPayload {
  action: string;
  arg: string;
}

/**
 * Signed, guild-bound, optionally expiring component IDs (PRD §6 button rules). The
 * signature stops forged or cross-guild IDs; it is *not* authorisation — every click is
 * still re-authorised server-side.
 */
export class ComponentIds {
  readonly #secret: Buffer;
  readonly #now: () => number;

  constructor(secret: string, now: () => number = Date.now) {
    this.#secret = Buffer.from(secret, 'utf8');
    this.#now = now;
  }

  #sign(guildId: string, body: string): string {
    return createHmac('sha256', this.#secret)
      .update(`${guildId}|${body}`)
      .digest('base64url')
      .slice(0, SIG_LEN);
  }

  /** @param ttlMs time to live; null for persistent panels (still re-authorised on click). */
  make(guildId: string, action: string, arg = '', ttlMs: number | null = 15 * 60_000): string {
    if (!/^[a-z0-9-]{1,16}$/.test(action)) throw new Error(`invalid action ${action}`);
    // Station ids contain one colon ("mypack:my-station"); it is carried as "." to keep 5 parts.
    if (!/^[A-Za-z0-9_-]*(:[A-Za-z0-9_-]+)?$/.test(arg)) throw new Error(`invalid component arg ${arg}`);
    const safeArg = arg.replace(':', '.');
    const exp = ttlMs === null ? '0' : Math.ceil((this.#now() + ttlMs) / 1000).toString(36);
    const body = `${PREFIX}:${action}:${safeArg}:${exp}`;
    const id = `${body}:${this.#sign(guildId, body)}`;
    if (id.length > MAX_LEN) throw new Error('custom id too long');
    return id;
  }

  /** Returns the payload, or null when forged, for another guild, malformed or expired. */
  parse(
    guildId: string,
    customId: string,
  ): (ComponentPayload & { expired: false }) | { expired: true } | null {
    const parts = customId.split(':');
    if (parts.length !== 5 || parts[0] !== PREFIX) return null;
    const [, action, safeArg, exp, sig] = parts as [string, string, string, string, string];
    const body = `${PREFIX}:${action}:${safeArg}:${exp}`;
    const expected = Buffer.from(this.#sign(guildId, body));
    const given = Buffer.from(sig);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
    if (exp !== '0' && Number.parseInt(exp, 36) * 1000 < this.#now()) return { expired: true };
    return { action, arg: safeArg.replace(/\./g, ':'), expired: false };
  }
}
