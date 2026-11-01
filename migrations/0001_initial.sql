-- Radio Bot initial schema (PRD §11).

CREATE TABLE app_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE stations (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL CHECK (length(provider) BETWEEN 1 AND 32),
  guild_id TEXT,
  canonical_slug TEXT NOT NULL,
  external_id TEXT,
  display_name TEXT NOT NULL,
  aliases_json TEXT NOT NULL DEFAULT '[]',
  description TEXT,
  genre_tags_json TEXT NOT NULL DEFAULT '[]',
  category TEXT,
  sort_order INTEGER NOT NULL DEFAULT 1000,
  website_url TEXT,
  language TEXT,
  official_page_url TEXT,
  official_catalog_last_seen_at TEXT,
  catalogue_status TEXT NOT NULL DEFAULT 'active'
    CHECK (catalogue_status IN ('active', 'missing_from_official', 'retired')),
  identity_status TEXT NOT NULL DEFAULT 'unverified'
    CHECK (identity_status IN ('verified', 'unverified', 'mismatch')),
  source_validation_status TEXT NOT NULL DEFAULT 'catalogued',
  artwork_url TEXT,
  artwork_rights_status TEXT,
  created_by_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  retired_at TEXT,
  CHECK ((provider = 'custom') = (guild_id IS NOT NULL))
);

CREATE UNIQUE INDEX ux_stations_slug ON stations (provider, COALESCE(guild_id, ''), canonical_slug);
CREATE INDEX ix_stations_guild ON stations (guild_id);

CREATE TABLE station_sources (
  id TEXT PRIMARY KEY,
  station_id TEXT NOT NULL REFERENCES stations (id) ON DELETE CASCADE,
  stream_url TEXT NOT NULL,
  label TEXT,
  priority INTEGER NOT NULL DEFAULT 100,
  transport_hint TEXT,
  codec_hint TEXT,
  transport TEXT NOT NULL DEFAULT 'unknown',
  container TEXT,
  codec TEXT,
  profile TEXT,
  sample_rate_hz INTEGER,
  channel_count INTEGER,
  channel_layout TEXT,
  advertised_bitrate_kbps REAL,
  codec_bitrate_kbps REAL,
  measured_bitrate_kbps REAL,
  bitrate_confidence TEXT NOT NULL DEFAULT 'unknown',
  identity_status TEXT NOT NULL DEFAULT 'unverified'
    CHECK (identity_status IN ('verified', 'unverified', 'mismatch')),
  identity_confidence TEXT NOT NULL DEFAULT 'none',
  identity_evidence_json TEXT NOT NULL DEFAULT '[]',
  identity_override TEXT CHECK (identity_override IN ('verified', 'mismatch')),
  quality_confidence TEXT NOT NULL DEFAULT 'unknown',
  rights_status TEXT NOT NULL DEFAULT 'unreviewed'
    CHECK (rights_status IN ('unreviewed', 'permitted', 'blocked')),
  source_provenance TEXT NOT NULL
    CHECK (source_provenance IN ('official-player', 'curated', 'auto-discovered', 'custom-user')),
  provenance_detail TEXT,
  is_enabled INTEGER NOT NULL DEFAULT 1,
  disabled_reason TEXT,
  verification_state TEXT NOT NULL DEFAULT 'discovered',
  icy_name TEXT,
  effective_host TEXT,
  startup_ms INTEGER,
  last_probe_at TEXT,
  last_success_at TEXT,
  last_failure_at TEXT,
  last_failure_code TEXT,
  health_score REAL NOT NULL DEFAULT 50,
  cooldown_until TEXT,
  failure_count INTEGER NOT NULL DEFAULT 0,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  cooldown_trips INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX ix_station_sources_station ON station_sources (station_id);

CREATE TABLE source_probe_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id TEXT NOT NULL REFERENCES station_sources (id) ON DELETE CASCADE,
  started_at TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  kind TEXT NOT NULL DEFAULT 'basic',
  effective_url_host TEXT,
  transport TEXT,
  container TEXT,
  codec TEXT,
  profile TEXT,
  sample_rate_hz INTEGER,
  channels INTEGER,
  bitrate_estimate REAL,
  bitrate_evidence TEXT,
  startup_ms INTEGER,
  headers_summary_json TEXT NOT NULL DEFAULT '{}',
  manifest_summary_json TEXT NOT NULL DEFAULT '{}',
  identity_evidence_json TEXT NOT NULL DEFAULT '[]',
  success INTEGER NOT NULL,
  failure_code TEXT,
  failure_detail TEXT,
  confidence TEXT NOT NULL DEFAULT 'none',
  probe_version INTEGER NOT NULL
);

CREATE INDEX ix_probe_results_source ON source_probe_results (source_id, started_at DESC);

CREATE TABLE guild_settings (
  guild_id TEXT PRIMARY KEY,
  allowed_text_channel_ids_json TEXT NOT NULL DEFAULT '[]',
  allowed_voice_channel_ids_json TEXT NOT NULL DEFAULT '[]',
  dj_role_ids_json TEXT NOT NULL DEFAULT '[]',
  member_control_mode TEXT NOT NULL DEFAULT 'same_channel'
    CHECK (member_control_mode IN ('none', 'same_channel', 'any')),
  default_station_id TEXT,
  preferred_voice_channel_id TEXT,
  voice_lock INTEGER NOT NULL DEFAULT 0,
  quality_mode TEXT NOT NULL DEFAULT 'maximum' CHECK (quality_mode IN ('maximum', 'balanced', 'manual')),
  manual_bitrate_kbps INTEGER,
  idle_mode TEXT NOT NULL DEFAULT 'leave_when_empty'
    CHECK (idle_mode IN ('24x7', 'pause_when_empty', 'leave_when_empty')),
  autostart INTEGER NOT NULL DEFAULT 0,
  resume_on_restart INTEGER NOT NULL DEFAULT 0,
  notification_channel_id TEXT,
  panel_channel_id TEXT,
  panel_message_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE guild_playback_state (
  guild_id TEXT PRIMARY KEY,
  desired_station_id TEXT,
  desired_voice_channel_id TEXT,
  desired_state TEXT NOT NULL DEFAULT 'idle'
    CHECK (desired_state IN ('idle', 'playing', 'paused_empty', 'stopped', 'left', 'kicked')),
  last_requested_at TEXT,
  last_requested_by_id TEXT,
  last_successful_source_id TEXT,
  last_error_code TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE guild_source_preferences (
  guild_id TEXT NOT NULL,
  station_id TEXT NOT NULL REFERENCES stations (id) ON DELETE CASCADE,
  selection_mode TEXT NOT NULL CHECK (selection_mode IN ('auto', 'prefer', 'pin')),
  preferred_source_id TEXT REFERENCES station_sources (id) ON DELETE CASCADE,
  updated_by_id TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (guild_id, station_id)
);

-- Stations lined up to play next. Radio never ends, so the queue advances on /radio skip.
CREATE TABLE guild_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  station_id TEXT NOT NULL REFERENCES stations (id) ON DELETE CASCADE,
  added_by_id TEXT,
  added_at TEXT NOT NULL
);

CREATE INDEX ix_guild_queue ON guild_queue (guild_id, id);

CREATE TABLE guild_favourites (
  guild_id TEXT NOT NULL,
  station_id TEXT NOT NULL REFERENCES stations (id) ON DELETE CASCADE,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  PRIMARY KEY (guild_id, station_id)
);

CREATE TABLE catalogue_sync_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT NOT NULL,
  success INTEGER NOT NULL,
  trigger TEXT NOT NULL,
  summary_json TEXT NOT NULL
);
