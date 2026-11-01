-- Per-server switch for showing what is playing as the voice channel's status (on by default).
-- Existing servers keep every setting and get the default.

ALTER TABLE guild_settings ADD COLUMN voice_channel_status INTEGER NOT NULL DEFAULT 1;
