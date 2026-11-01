import type { IdleMode, QualityMode } from '../../config/env.ts';
import { type Db, nowIso, parseJsonArray, type Row } from '../db.ts';

export type MemberControlMode = 'none' | 'same_channel' | 'any';
export type DesiredState = 'idle' | 'playing' | 'paused_empty' | 'stopped' | 'left' | 'kicked';
export type SelectionMode = 'auto' | 'prefer' | 'pin';

export interface GuildSettings {
  guildId: string;
  allowedTextChannelIds: string[];
  allowedVoiceChannelIds: string[];
  djRoleIds: string[];
  memberControlMode: MemberControlMode;
  defaultStationId: string | null;
  preferredVoiceChannelId: string | null;
  voiceLock: boolean;
  qualityMode: QualityMode;
  manualBitrateKbps: number | null;
  idleMode: IdleMode;
  autostart: boolean;
  resumeOnRestart: boolean;
  /** Show what is playing as the voice channel's status (needs Set Voice Channel Status). */
  voiceChannelStatus: boolean;
  notificationChannelId: string | null;
  panelChannelId: string | null;
  panelMessageId: string | null;
  updatedAt: string;
}

export interface PlaybackIntent {
  guildId: string;
  desiredStationId: string | null;
  desiredVoiceChannelId: string | null;
  desiredState: DesiredState;
  lastRequestedAt: string | null;
  lastRequestedById: string | null;
  lastSuccessfulSourceId: string | null;
  lastErrorCode: string | null;
  updatedAt: string;
}

export interface SourcePreference {
  guildId: string;
  stationId: string;
  mode: SelectionMode;
  sourceId: string | null;
  updatedAt: string;
}

export interface QueueEntry {
  id: number;
  stationId: string;
  addedById: string | null;
  addedAt: string;
}

export const MAX_QUEUE_LENGTH = 25;

export interface GuildDefaults {
  qualityMode: QualityMode;
  idleMode: IdleMode;
  resumeOnRestart: boolean;
}

const s = (v: unknown): string | null => (typeof v === 'string' ? v : null);

function mapSettings(r: Row): GuildSettings {
  return {
    guildId: String(r.guild_id),
    allowedTextChannelIds: parseJsonArray(r.allowed_text_channel_ids_json),
    allowedVoiceChannelIds: parseJsonArray(r.allowed_voice_channel_ids_json),
    djRoleIds: parseJsonArray(r.dj_role_ids_json),
    memberControlMode: r.member_control_mode as MemberControlMode,
    defaultStationId: s(r.default_station_id),
    preferredVoiceChannelId: s(r.preferred_voice_channel_id),
    voiceLock: Number(r.voice_lock) === 1,
    qualityMode: r.quality_mode as QualityMode,
    manualBitrateKbps: r.manual_bitrate_kbps == null ? null : Number(r.manual_bitrate_kbps),
    idleMode: r.idle_mode as IdleMode,
    autostart: Number(r.autostart) === 1,
    resumeOnRestart: Number(r.resume_on_restart) === 1,
    voiceChannelStatus: Number(r.voice_channel_status ?? 1) === 1,
    notificationChannelId: s(r.notification_channel_id),
    panelChannelId: s(r.panel_channel_id),
    panelMessageId: s(r.panel_message_id),
    updatedAt: String(r.updated_at),
  };
}

function mapIntent(r: Row): PlaybackIntent {
  return {
    guildId: String(r.guild_id),
    desiredStationId: s(r.desired_station_id),
    desiredVoiceChannelId: s(r.desired_voice_channel_id),
    desiredState: r.desired_state as DesiredState,
    lastRequestedAt: s(r.last_requested_at),
    lastRequestedById: s(r.last_requested_by_id),
    lastSuccessfulSourceId: s(r.last_successful_source_id),
    lastErrorCode: s(r.last_error_code),
    updatedAt: String(r.updated_at),
  };
}

export type SettingsPatch = Partial<Omit<GuildSettings, 'guildId' | 'updatedAt'>>;

const SETTINGS_COLUMNS: Record<keyof SettingsPatch, [string, 'json' | 'bool' | 'raw']> = {
  allowedTextChannelIds: ['allowed_text_channel_ids_json', 'json'],
  allowedVoiceChannelIds: ['allowed_voice_channel_ids_json', 'json'],
  djRoleIds: ['dj_role_ids_json', 'json'],
  memberControlMode: ['member_control_mode', 'raw'],
  defaultStationId: ['default_station_id', 'raw'],
  preferredVoiceChannelId: ['preferred_voice_channel_id', 'raw'],
  voiceLock: ['voice_lock', 'bool'],
  qualityMode: ['quality_mode', 'raw'],
  manualBitrateKbps: ['manual_bitrate_kbps', 'raw'],
  idleMode: ['idle_mode', 'raw'],
  autostart: ['autostart', 'bool'],
  resumeOnRestart: ['resume_on_restart', 'bool'],
  voiceChannelStatus: ['voice_channel_status', 'bool'],
  notificationChannelId: ['notification_channel_id', 'raw'],
  panelChannelId: ['panel_channel_id', 'raw'],
  panelMessageId: ['panel_message_id', 'raw'],
};

export class GuildRepository {
  readonly #db: Db;
  readonly #defaults: GuildDefaults;

  constructor(db: Db, defaults: GuildDefaults) {
    this.#db = db;
    this.#defaults = defaults;
  }

  /** Returns settings, creating a row with installation defaults on first access. */
  getSettings(guildId: string): GuildSettings {
    const r = this.#db.get('SELECT * FROM guild_settings WHERE guild_id = ?', [guildId]);
    if (r) return mapSettings(r);
    const now = nowIso();
    this.#db.run(
      `INSERT OR IGNORE INTO guild_settings (guild_id, quality_mode, idle_mode, resume_on_restart, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        guildId,
        this.#defaults.qualityMode,
        this.#defaults.idleMode,
        this.#defaults.resumeOnRestart ? 1 : 0,
        now,
        now,
      ],
    );
    return mapSettings(this.#db.get('SELECT * FROM guild_settings WHERE guild_id = ?', [guildId])!);
  }

  updateSettings(guildId: string, patch: SettingsPatch): GuildSettings {
    this.getSettings(guildId);
    const sets: string[] = [];
    const params: Array<string | number | null> = [];
    for (const [key, [column, kind]] of Object.entries(SETTINGS_COLUMNS) as Array<
      [keyof SettingsPatch, [string, 'json' | 'bool' | 'raw']]
    >) {
      if (!(key in patch)) continue;
      const value = patch[key];
      sets.push(`${column} = ?`);
      if (kind === 'json') params.push(JSON.stringify(value ?? []));
      else if (kind === 'bool') params.push(value ? 1 : 0);
      else params.push((value as string | number | null | undefined) ?? null);
    }
    if (sets.length > 0) {
      sets.push('updated_at = ?');
      params.push(nowIso(), guildId);
      this.#db.run(`UPDATE guild_settings SET ${sets.join(', ')} WHERE guild_id = ?`, params);
    }
    return this.getSettings(guildId);
  }

  listGuildIdsWithSettings(): string[] {
    return this.#db.all<{ guild_id: string }>('SELECT guild_id FROM guild_settings').map((r) => r.guild_id);
  }

  // ---- playback intent (desired state, survives restarts) ----

  getIntent(guildId: string): PlaybackIntent | null {
    const r = this.#db.get('SELECT * FROM guild_playback_state WHERE guild_id = ?', [guildId]);
    return r ? mapIntent(r) : null;
  }

  listIntents(): PlaybackIntent[] {
    return this.#db.all('SELECT * FROM guild_playback_state').map(mapIntent);
  }

  setIntent(
    guildId: string,
    patch: Partial<Omit<PlaybackIntent, 'guildId' | 'updatedAt'>> & { desiredState: DesiredState },
  ): PlaybackIntent {
    const cur = this.getIntent(guildId);
    const next: PlaybackIntent = {
      guildId,
      desiredStationId:
        'desiredStationId' in patch ? (patch.desiredStationId ?? null) : (cur?.desiredStationId ?? null),
      desiredVoiceChannelId:
        'desiredVoiceChannelId' in patch
          ? (patch.desiredVoiceChannelId ?? null)
          : (cur?.desiredVoiceChannelId ?? null),
      desiredState: patch.desiredState,
      lastRequestedAt:
        'lastRequestedAt' in patch ? (patch.lastRequestedAt ?? null) : (cur?.lastRequestedAt ?? null),
      lastRequestedById:
        'lastRequestedById' in patch ? (patch.lastRequestedById ?? null) : (cur?.lastRequestedById ?? null),
      lastSuccessfulSourceId:
        'lastSuccessfulSourceId' in patch
          ? (patch.lastSuccessfulSourceId ?? null)
          : (cur?.lastSuccessfulSourceId ?? null),
      lastErrorCode: 'lastErrorCode' in patch ? (patch.lastErrorCode ?? null) : (cur?.lastErrorCode ?? null),
      updatedAt: nowIso(),
    };
    this.#db.run(
      `INSERT INTO guild_playback_state (guild_id, desired_station_id, desired_voice_channel_id, desired_state,
         last_requested_at, last_requested_by_id, last_successful_source_id, last_error_code, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (guild_id) DO UPDATE SET desired_station_id = excluded.desired_station_id,
         desired_voice_channel_id = excluded.desired_voice_channel_id, desired_state = excluded.desired_state,
         last_requested_at = excluded.last_requested_at, last_requested_by_id = excluded.last_requested_by_id,
         last_successful_source_id = excluded.last_successful_source_id, last_error_code = excluded.last_error_code,
         updated_at = excluded.updated_at`,
      [
        next.guildId,
        next.desiredStationId,
        next.desiredVoiceChannelId,
        next.desiredState,
        next.lastRequestedAt,
        next.lastRequestedById,
        next.lastSuccessfulSourceId,
        next.lastErrorCode,
        next.updatedAt,
      ],
    );
    return next;
  }

  // ---- source preferences ----

  getPreference(guildId: string, stationId: string): SourcePreference | null {
    const r = this.#db.get('SELECT * FROM guild_source_preferences WHERE guild_id = ? AND station_id = ?', [
      guildId,
      stationId,
    ]);
    if (!r) return null;
    return {
      guildId,
      stationId,
      mode: r.selection_mode as SelectionMode,
      sourceId: s(r.preferred_source_id),
      updatedAt: String(r.updated_at),
    };
  }

  listPreferences(guildId: string): SourcePreference[] {
    return this.#db.all('SELECT * FROM guild_source_preferences WHERE guild_id = ?', [guildId]).map((r) => ({
      guildId,
      stationId: String(r.station_id),
      mode: r.selection_mode as SelectionMode,
      sourceId: s(r.preferred_source_id),
      updatedAt: String(r.updated_at),
    }));
  }

  setPreference(
    guildId: string,
    stationId: string,
    mode: SelectionMode,
    sourceId: string | null,
    byId: string | null,
  ): void {
    if (mode === 'auto') {
      this.#db.run('DELETE FROM guild_source_preferences WHERE guild_id = ? AND station_id = ?', [
        guildId,
        stationId,
      ]);
      return;
    }
    this.#db.run(
      `INSERT INTO guild_source_preferences (guild_id, station_id, selection_mode, preferred_source_id, updated_by_id, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (guild_id, station_id) DO UPDATE SET selection_mode = excluded.selection_mode,
         preferred_source_id = excluded.preferred_source_id, updated_by_id = excluded.updated_by_id,
         updated_at = excluded.updated_at`,
      [guildId, stationId, mode, sourceId, byId, nowIso()],
    );
  }

  // ---- station queue ----

  listQueue(guildId: string): QueueEntry[] {
    return this.#db.all('SELECT * FROM guild_queue WHERE guild_id = ? ORDER BY id', [guildId]).map((r) => ({
      id: Number(r.id),
      stationId: String(r.station_id),
      addedById: s(r.added_by_id),
      addedAt: String(r.added_at),
    }));
  }

  /** Appends a station; returns its 1-based position, or null when the queue is full. */
  enqueue(guildId: string, stationId: string, addedById: string | null): number | null {
    return this.#db.transaction(() => {
      const length = this.listQueue(guildId).length;
      if (length >= MAX_QUEUE_LENGTH) return null;
      this.#db.run(
        'INSERT INTO guild_queue (guild_id, station_id, added_by_id, added_at) VALUES (?, ?, ?, ?)',
        [guildId, stationId, addedById, nowIso()],
      );
      return length + 1;
    });
  }

  /** Removes and returns the next queued station. */
  dequeue(guildId: string): QueueEntry | null {
    return this.#db.transaction(() => {
      const next = this.listQueue(guildId)[0] ?? null;
      if (next) this.#db.run('DELETE FROM guild_queue WHERE id = ?', [next.id]);
      return next;
    });
  }

  /** Removes the entry at a 1-based position; returns it, or null if out of range. */
  removeFromQueue(guildId: string, position: number): QueueEntry | null {
    const entry = this.listQueue(guildId)[position - 1] ?? null;
    if (entry) this.#db.run('DELETE FROM guild_queue WHERE id = ? AND guild_id = ?', [entry.id, guildId]);
    return entry;
  }

  /** Removes one entry by its id (used once a skipped-to station has actually started). */
  removeQueueEntry(guildId: string, id: number): boolean {
    return this.#db.run('DELETE FROM guild_queue WHERE id = ? AND guild_id = ?', [id, guildId]).changes > 0;
  }

  clearQueue(guildId: string): number {
    return this.#db.run('DELETE FROM guild_queue WHERE guild_id = ?', [guildId]).changes;
  }

  // ---- favourites ----

  listFavourites(guildId: string): string[] {
    return this.#db
      .all<{ station_id: string }>(
        'SELECT station_id FROM guild_favourites WHERE guild_id = ? ORDER BY position, created_at',
        [guildId],
      )
      .map((r) => r.station_id);
  }

  isFavourite(guildId: string, stationId: string): boolean {
    return Boolean(
      this.#db.get('SELECT 1 AS x FROM guild_favourites WHERE guild_id = ? AND station_id = ?', [
        guildId,
        stationId,
      ]),
    );
  }

  /** Toggles a guild favourite; returns the new state. */
  toggleFavourite(guildId: string, stationId: string): boolean {
    return this.#db.transaction(() => {
      if (this.isFavourite(guildId, stationId)) {
        this.#db.run('DELETE FROM guild_favourites WHERE guild_id = ? AND station_id = ?', [
          guildId,
          stationId,
        ]);
        return false;
      }
      const pos = this.#db.get<{ p: number | null }>(
        'SELECT MAX(position) AS p FROM guild_favourites WHERE guild_id = ?',
        [guildId],
      );
      this.#db.run(
        'INSERT INTO guild_favourites (guild_id, station_id, position, created_at) VALUES (?, ?, ?, ?)',
        [guildId, stationId, (pos?.p ?? -1) + 1, nowIso()],
      );
      return true;
    });
  }

  setFavourites(guildId: string, stationIds: string[]): void {
    this.#db.transaction(() => {
      this.#db.run('DELETE FROM guild_favourites WHERE guild_id = ?', [guildId]);
      stationIds.forEach((id, i) => {
        this.#db.run(
          'INSERT INTO guild_favourites (guild_id, station_id, position, created_at) VALUES (?, ?, ?, ?)',
          [guildId, id, i, nowIso()],
        );
      });
    });
  }

  /** Removes all operator-held data for a guild (bot removed from server / deletion request). */
  purgeGuild(guildId: string): void {
    this.#db.transaction(() => {
      for (const table of [
        'guild_queue',
        'guild_favourites',
        'guild_source_preferences',
        'guild_playback_state',
        'guild_settings',
      ]) {
        this.#db.run(`DELETE FROM ${table} WHERE guild_id = ?`, [guildId]);
      }
      // Discord drops the guild's commands on removal, so a re-invite must register them again.
      this.#db.run('DELETE FROM app_meta WHERE key = ?', [`commands.hash.${guildId}`]);
    });
  }
}

export class MetaRepository {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  get(key: string): string | null {
    return this.#db.get<{ value: string }>('SELECT value FROM app_meta WHERE key = ?', [key])?.value ?? null;
  }

  set(key: string, value: string): void {
    this.#db.run(
      `INSERT INTO app_meta (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      [key, value, nowIso()],
    );
  }

  getOrCreate(key: string, create: () => string): string {
    const existing = this.get(key);
    if (existing) return existing;
    const value = create();
    this.set(key, value);
    return value;
  }
}
