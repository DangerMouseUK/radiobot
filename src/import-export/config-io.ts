import { z } from 'zod';
import { IDLE_MODES, QUALITY_MODES } from '../config/env.ts';
import type { GuildRepository, SettingsPatch } from '../persistence/repositories/guilds.ts';
import type { StationRepository } from '../persistence/repositories/stations.ts';
import { redactUrl } from '../shared/redact.ts';

export const EXPORT_SCHEMA = 'radio-bot/guild-config';
export const EXPORT_VERSION = 1;

const snowflake = z.string().regex(/^\d{17,20}$/);
const stationId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}:[a-z0-9-]{1,64}$/);

export const guildExportSchema = z.object({
  schema: z.literal(EXPORT_SCHEMA),
  version: z.literal(EXPORT_VERSION),
  exportedAt: z.string().max(40),
  settings: z.object({
    allowedTextChannelIds: z.array(snowflake).max(50),
    allowedVoiceChannelIds: z.array(snowflake).max(50),
    djRoleIds: z.array(snowflake).max(50),
    memberControlMode: z.enum(['none', 'same_channel', 'any']),
    defaultStationId: stationId.nullable(),
    preferredVoiceChannelId: snowflake.nullable(),
    voiceLock: z.boolean(),
    qualityMode: z.enum(QUALITY_MODES),
    manualBitrateKbps: z.number().int().min(32).max(510).nullable(),
    idleMode: z.enum(IDLE_MODES),
    autostart: z.boolean(),
    resumeOnRestart: z.boolean(),
    notificationChannelId: snowflake.nullable(),
  }),
  favourites: z
    .array(stationId)
    .max(200)
    .transform((ids) => [...new Set(ids)]),
  sourcePreferences: z
    .array(
      z.object({
        stationId,
        mode: z.enum(['prefer', 'pin']),
        sourceId: z.string().regex(/^[a-z0-9-]{1,100}$/),
      }),
    )
    .max(200),
  customStations: z
    .array(
      z.object({
        name: z.string().min(2).max(60),
        url: z.string().max(2048),
        urlRedacted: z.boolean(),
        website: z.string().max(300).nullable(),
        description: z.string().max(300).nullable(),
        category: z.string().max(40).nullable(),
        language: z.string().max(20).nullable(),
      }),
    )
    .max(500),
});

export type GuildExport = z.infer<typeof guildExportSchema>;

/**
 * Non-secret export (PRD §11.2, NFR-11): Discord IDs and preferences only. Custom stream URLs
 * that carry query strings (potential tokens) are exported redacted and flagged so they must be
 * re-entered by an administrator on import.
 */
export function exportGuild(
  guildId: string,
  guilds: GuildRepository,
  stations: StationRepository,
): GuildExport {
  const s = guilds.getSettings(guildId);
  const custom = stations
    .listStations(guildId)
    .filter((st) => st.provider === 'custom' && st.guildId === guildId);
  return {
    schema: EXPORT_SCHEMA,
    version: EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    settings: {
      allowedTextChannelIds: s.allowedTextChannelIds,
      allowedVoiceChannelIds: s.allowedVoiceChannelIds,
      djRoleIds: s.djRoleIds,
      memberControlMode: s.memberControlMode,
      defaultStationId:
        s.defaultStationId && !s.defaultStationId.startsWith('custom:') ? s.defaultStationId : null,
      preferredVoiceChannelId: s.preferredVoiceChannelId,
      voiceLock: s.voiceLock,
      qualityMode: s.qualityMode,
      manualBitrateKbps: s.manualBitrateKbps,
      idleMode: s.idleMode,
      autostart: s.autostart,
      resumeOnRestart: s.resumeOnRestart,
      notificationChannelId: s.notificationChannelId,
    },
    favourites: guilds.listFavourites(guildId).filter((id) => !id.startsWith('custom:')),
    sourcePreferences: guilds
      .listPreferences(guildId)
      .filter((p) => p.mode !== 'auto' && p.sourceId && !p.stationId.startsWith('custom:'))
      .map((p) => ({ stationId: p.stationId, mode: p.mode as 'prefer' | 'pin', sourceId: p.sourceId! })),
    customStations: custom.map((st) => {
      const src = stations.listSources(st.id)[0];
      const raw = src?.url ?? '';
      let hasSecretParts = true;
      try {
        const u = new URL(raw);
        hasSecretParts = u.search.length > 0 || u.username.length > 0 || u.password.length > 0;
      } catch {
        /* treat as secret */
      }
      return {
        name: st.displayName,
        url: hasSecretParts ? redactUrl(raw) : raw,
        urlRedacted: hasSecretParts,
        website: st.websiteUrl,
        description: st.description,
        category: st.category,
        language: st.language,
      };
    }),
  };
}

export interface ImportPreview {
  data: GuildExport;
  lines: string[];
  warnings: string[];
}

export function parseImport(text: string): GuildExport {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error('The file is not valid JSON.');
  }
  const r = guildExportSchema.safeParse(json);
  if (!r.success) {
    const first = r.error.issues.slice(0, 5).map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new Error(`The file is not a valid Radio Bot export:\n${first.join('\n')}`);
  }
  return r.data;
}

/** Validates against the current guild/catalogue and describes what would change. */
export function previewImport(
  guildId: string,
  data: GuildExport,
  guilds: GuildRepository,
  stations: StationRepository,
  existingChannelIds: ReadonlySet<string>,
  existingRoleIds: ReadonlySet<string>,
): ImportPreview {
  const cur = guilds.getSettings(guildId);
  const lines: string[] = [];
  const warnings: string[] = [];
  const s = data.settings;
  const diff = (label: string, a: unknown, b: unknown) => {
    if (JSON.stringify(a) !== JSON.stringify(b))
      lines.push(`• ${label}: ${JSON.stringify(a)} → ${JSON.stringify(b)}`);
  };
  diff('Allowed text channels', cur.allowedTextChannelIds.length, s.allowedTextChannelIds.length);
  diff('Allowed voice channels', cur.allowedVoiceChannelIds.length, s.allowedVoiceChannelIds.length);
  diff('DJ roles', cur.djRoleIds.length, s.djRoleIds.length);
  diff('Member control', cur.memberControlMode, s.memberControlMode);
  diff('Default station', cur.defaultStationId, s.defaultStationId);
  diff('Quality mode', cur.qualityMode, s.qualityMode);
  diff('Idle mode', cur.idleMode, s.idleMode);
  diff('Autostart', cur.autostart, s.autostart);
  diff('Resume on restart', cur.resumeOnRestart, s.resumeOnRestart);
  diff('Voice lock', cur.voiceLock, s.voiceLock);
  const unknownChannels = [
    ...s.allowedTextChannelIds,
    ...s.allowedVoiceChannelIds,
    ...(s.preferredVoiceChannelId ? [s.preferredVoiceChannelId] : []),
    ...(s.notificationChannelId ? [s.notificationChannelId] : []),
  ].filter((id) => !existingChannelIds.has(id));
  if (unknownChannels.length > 0)
    warnings.push(`${unknownChannels.length} channel ID(s) do not exist here and will be dropped.`);
  const unknownRoles = [...s.djRoleIds].filter((id) => !existingRoleIds.has(id));
  if (unknownRoles.length > 0)
    warnings.push(`${unknownRoles.length} role ID(s) do not exist here and will be dropped.`);
  const unknownStations = [...data.favourites, ...(s.defaultStationId ? [s.defaultStationId] : [])].filter(
    (id) => !stations.getVisibleStation(guildId, id),
  );
  if (unknownStations.length > 0)
    warnings.push(`${unknownStations.length} station ID(s) are not in this catalogue and will be skipped.`);
  lines.push(`• Favourites: ${data.favourites.length}`);
  lines.push(`• Source preferences: ${data.sourcePreferences.length}`);
  const importable = data.customStations.filter((c) => !c.urlRedacted);
  lines.push(`• Custom stations to add: ${importable.length} (each is re-validated before it is added)`);
  const redacted = data.customStations.length - importable.length;
  if (redacted > 0)
    warnings.push(
      `${redacted} custom station URL(s) were redacted on export and will be skipped; re-add them manually.`,
    );
  return { data, lines, warnings };
}

/** Applies settings, favourites and preferences atomically (custom stations are added separately). */
export function applyImport(
  guildId: string,
  data: GuildExport,
  guilds: GuildRepository,
  stations: StationRepository,
  existingChannelIds: ReadonlySet<string>,
  existingRoleIds: ReadonlySet<string>,
  transaction: <T>(fn: () => T) => T,
): void {
  const ch = (ids: string[]) => ids.filter((id) => existingChannelIds.has(id));
  const rl = (ids: string[]) => ids.filter((id) => existingRoleIds.has(id));
  const s = data.settings;
  const patch: SettingsPatch = {
    allowedTextChannelIds: ch(s.allowedTextChannelIds),
    allowedVoiceChannelIds: ch(s.allowedVoiceChannelIds),
    djRoleIds: rl(s.djRoleIds),
    memberControlMode: s.memberControlMode,
    defaultStationId:
      s.defaultStationId && stations.getVisibleStation(guildId, s.defaultStationId)
        ? s.defaultStationId
        : null,
    preferredVoiceChannelId:
      s.preferredVoiceChannelId && existingChannelIds.has(s.preferredVoiceChannelId)
        ? s.preferredVoiceChannelId
        : null,
    voiceLock: s.voiceLock,
    qualityMode: s.qualityMode,
    manualBitrateKbps: s.manualBitrateKbps,
    idleMode: s.idleMode,
    autostart: s.autostart,
    resumeOnRestart: s.resumeOnRestart,
    notificationChannelId:
      s.notificationChannelId && existingChannelIds.has(s.notificationChannelId)
        ? s.notificationChannelId
        : null,
  };
  transaction(() => {
    guilds.updateSettings(guildId, patch);
    guilds.setFavourites(
      guildId,
      data.favourites.filter((id) => stations.getVisibleStation(guildId, id)),
    );
    for (const p of data.sourcePreferences) {
      const src = stations.getSource(p.sourceId);
      if (src && src.stationId === p.stationId && stations.getVisibleStation(guildId, p.stationId))
        guilds.setPreference(guildId, p.stationId, p.mode, p.sourceId, null);
    }
  });
}
