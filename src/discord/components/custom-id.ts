import { createHmac, timingSafeEqual } from 'node:crypto';

const PREFIX = 'rb2';
/** IDs from 1.0.5 and earlier (expiry in seconds). Still verified, then treated as expired. */
const LEGACY_PREFIX = 'rb1';
const SIG_LEN = 16;
const MAX_LEN = 100;
/** Expiry is counted in whole minutes from here, so it stays five base-36 digits until 2140. */
const EPOCH_MS = Date.UTC(2026, 0, 1);

/** The longest argument: a station id, a 32-character pack id, ":" and a 32-character slug (packs.ts). */
export const MAX_ARG_LENGTH = 65;
/**
 * The longest action name. "rb2:" + action + ":" + arg + ":" + five-digit expiry + ":" + signature
 * is then at most 4 + 7 + 1 + 65 + 1 + 5 + 1 + 16 = 100 characters, Discord's limit, whatever the arg.
 */
export const MAX_ACTION_LENGTH = 7;

/** Every component action. A new one goes here, at most MAX_ACTION_LENGTH lower-case characters. */
export const COMPONENT_ACTIONS = [
  'bfav',
  'browse',
  'cfg',
  'close',
  'fav',
  'imp',
  'impx',
  'insp',
  'leave',
  'list',
  'next',
  'now',
  'obrowse',
  'pick',
  'play',
  'prev',
  'rescan',
  'sauto',
  'skip',
  'spref',
  'srcs',
  'stats',
  'stop',
  'usesrc',
] as const;
export type ComponentAction = (typeof COMPONENT_ACTIONS)[number];
const ACTIONS: ReadonlySet<string> = new Set(COMPONENT_ACTIONS);

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

  /**
   * @param ttlMs time to live, rounded up to a whole minute; null for persistent panels (still
   *   re-authorised on click).
   */
  make(guildId: string, action: ComponentAction, arg = '', ttlMs: number | null = 15 * 60_000): string {
    if (!ACTIONS.has(action)) throw new Error(`invalid action ${action}`);
    // Station ids contain one colon ("mypack:my-station"); it is carried as "." to keep 5 parts.
    if (arg.length > MAX_ARG_LENGTH || !/^[A-Za-z0-9_-]*(:[A-Za-z0-9_-]+)?$/.test(arg))
      throw new Error(`invalid component arg ${arg}`);
    const safeArg = arg.replace(':', '.');
    // "0" means persistent, so a timed id expires no earlier than minute 1.
    const exp =
      ttlMs === null ? '0' : Math.max(1, Math.ceil((this.#now() + ttlMs - EPOCH_MS) / 60_000)).toString(36);
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
    if (parts.length !== 5 || (parts[0] !== PREFIX && parts[0] !== LEGACY_PREFIX)) return null;
    const [prefix, action, safeArg, exp, sig] = parts as [string, string, string, string, string];
    const body = `${prefix}:${action}:${safeArg}:${exp}`;
    const expected = Buffer.from(this.#sign(guildId, body));
    const given = Buffer.from(sig);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
    if (prefix === LEGACY_PREFIX) return { expired: true };
    if (exp !== '0' && EPOCH_MS + Number.parseInt(exp, 36) * 60_000 < this.#now()) return { expired: true };
    return { action, arg: safeArg.replace(/\./g, ':'), expired: false };
  }
}
