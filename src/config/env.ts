import { z } from 'zod';

const bool = z
  .string()
  .trim()
  .toLowerCase()
  .transform((v, ctx) => {
    if (['1', 'true', 'yes', 'on'].includes(v)) return true;
    if (['0', 'false', 'no', 'off', ''].includes(v)) return false;
    ctx.addIssue({ code: 'custom', message: `must be true or false, not "${v}"` });
    return z.NEVER;
  });

const int = (min: number, max: number) => z.coerce.number().int().min(min).max(max);

const snowflake = z.string().regex(/^\d{17,20}$/, 'must be a Discord ID (17 to 20 digits)');

export const QUALITY_MODES = ['maximum', 'balanced', 'manual'] as const;
export const IDLE_MODES = ['24x7', 'pause_when_empty', 'leave_when_empty'] as const;
export type QualityMode = (typeof QUALITY_MODES)[number];
export type IdleMode = (typeof IDLE_MODES)[number];
export const PRESENCE_MODES = ['track', 'station', 'off'] as const;
export type PresenceMode = (typeof PRESENCE_MODES)[number];

const envSchema = z.object({
  DISCORD_TOKEN: z.string().min(20, 'is missing or not long enough to be a bot token'),
  DISCORD_APPLICATION_ID: snowflake,
  DISCORD_DEV_GUILD_ID: z.union([snowflake, z.literal('')]).optional(),
  REGISTER_COMMANDS_ON_START: bool.default(true),
  DATABASE_PATH: z.string().min(1).default('./data/radio-bot.sqlite'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  FFMPEG_PATH: z.string().min(1).default('ffmpeg'),
  FFPROBE_PATH: z.string().min(1).default('ffprobe'),
  CATALOG_SYNC_ENABLED: bool.default(true),
  CATALOG_SYNC_INTERVAL_HOURS: int(6, 24 * 30).default(24),
  DEFAULT_QUALITY_MODE: z.enum(QUALITY_MODES).default('maximum'),
  DEFAULT_IDLE_MODE: z.enum(IDLE_MODES).default('leave_when_empty'),
  PRESENCE_MODE: z.enum(PRESENCE_MODES).default('track'),
  MAX_ACTIVE_GUILD_STREAMS: int(1, 1000).default(3),
  MAX_CONCURRENT_PROBES: int(1, 16).default(2),
  MAX_OPUS_BITRATE_KBPS: int(32, 510).default(510),
  STREAM_USER_AGENT: z.string().max(300).default(''),
  MAX_CUSTOM_STATIONS_PER_GUILD: int(0, 500).default(25),
  AUTO_RESUME_DEFAULT: bool.default(false),
  ALLOW_INSECURE_HTTP_STREAMS: bool.default(true),
  TELEMETRY_ENABLED: bool.default(false),
  DIAGNOSTICS_PORT: z.union([int(1, 65535), z.literal('')]).optional(),
  PROBE_HISTORY_LIMIT: int(1, 1000).default(30),
  DISABLED_PACKS: z.string().default(''),
  ENABLED_PACKS: z.string().default(''),
  EXTRA_PACKS_DIR: z.string().default(''),
  OPERATOR_USER_IDS: z.string().default(''),
  DISABLED_SOURCE_IDS: z.string().default(''),
  DISABLED_STATION_IDS: z.string().default(''),
  PROBE_HISTORY_DAYS: int(1, 365).default(30),
});

export type Env = z.infer<typeof envSchema>;

export interface AppConfig {
  discordToken: string;
  applicationId: string;
  devGuildId: string | null;
  registerCommandsOnStart: boolean;
  databasePath: string;
  logLevel: Env['LOG_LEVEL'];
  ffmpegPath: string;
  ffprobePath: string;
  catalogSyncEnabled: boolean;
  catalogSyncIntervalHours: number;
  defaultQualityMode: QualityMode;
  defaultIdleMode: IdleMode;
  /** What the bot's own Discord status shows while it plays: station and track, station only, or nothing. */
  presenceMode: PresenceMode;
  maxActiveGuildStreams: number;
  maxConcurrentProbes: number;
  maxOpusBitrateKbps: number;
  /** Overrides the User-Agent used for stream requests (default: the installed FFmpeg's). */
  streamUserAgent: string | null;
  maxCustomStationsPerGuild: number;
  autoResumeDefault: boolean;
  allowInsecureHttpStreams: boolean;
  diagnosticsPort: number | null;
  probeHistoryLimit: number;
  probeHistoryDays: number;
  /** Pack ids switched off / on (overriding each pack's enabledByDefault). */
  disabledPacks: Set<string>;
  enabledPacks: Set<string>;
  /** Optional directory of operator-supplied pack folders. */
  extraPacksDir: string | null;
  /** Discord user IDs allowed to make installation-wide decisions (identity overrides). */
  operatorUserIds: string[];
  disabledSourceIds: Set<string>;
  disabledStationIds: Set<string>;
}

const list = (v: string) =>
  v
    .split(/[\s,]+/)
    .map((x) => x.trim())
    .filter(Boolean);

export class ConfigError extends Error {
  override name = 'ConfigError';
}

/** Parses and validates process environment. Never echoes secret values in errors. */
export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const lines = result.error.issues.map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new ConfigError(`Invalid configuration:\n${lines.join('\n')}`);
  }
  const e = result.data;
  if (e.TELEMETRY_ENABLED) {
    throw new ConfigError('TELEMETRY_ENABLED=true is not supported: Radio Bot ships no telemetry.');
  }
  return {
    discordToken: e.DISCORD_TOKEN,
    applicationId: e.DISCORD_APPLICATION_ID,
    devGuildId: e.DISCORD_DEV_GUILD_ID ? e.DISCORD_DEV_GUILD_ID : null,
    registerCommandsOnStart: e.REGISTER_COMMANDS_ON_START,
    databasePath: e.DATABASE_PATH,
    logLevel: e.LOG_LEVEL,
    ffmpegPath: e.FFMPEG_PATH,
    ffprobePath: e.FFPROBE_PATH,
    catalogSyncEnabled: e.CATALOG_SYNC_ENABLED,
    catalogSyncIntervalHours: e.CATALOG_SYNC_INTERVAL_HOURS,
    defaultQualityMode: e.DEFAULT_QUALITY_MODE,
    defaultIdleMode: e.DEFAULT_IDLE_MODE,
    presenceMode: e.PRESENCE_MODE,
    maxActiveGuildStreams: e.MAX_ACTIVE_GUILD_STREAMS,
    maxConcurrentProbes: e.MAX_CONCURRENT_PROBES,
    maxOpusBitrateKbps: e.MAX_OPUS_BITRATE_KBPS,
    streamUserAgent: e.STREAM_USER_AGENT.trim() || null,
    maxCustomStationsPerGuild: e.MAX_CUSTOM_STATIONS_PER_GUILD,
    autoResumeDefault: e.AUTO_RESUME_DEFAULT,
    allowInsecureHttpStreams: e.ALLOW_INSECURE_HTTP_STREAMS,
    diagnosticsPort: typeof e.DIAGNOSTICS_PORT === 'number' ? e.DIAGNOSTICS_PORT : null,
    probeHistoryLimit: e.PROBE_HISTORY_LIMIT,
    probeHistoryDays: e.PROBE_HISTORY_DAYS,
    disabledPacks: new Set(list(e.DISABLED_PACKS)),
    enabledPacks: new Set(list(e.ENABLED_PACKS)),
    extraPacksDir: e.EXTRA_PACKS_DIR.trim() || null,
    operatorUserIds: list(e.OPERATOR_USER_IDS).filter((id) => /^\d{17,20}$/.test(id)),
    disabledSourceIds: new Set(list(e.DISABLED_SOURCE_IDS)),
    disabledStationIds: new Set(list(e.DISABLED_STATION_IDS)),
  };
}
