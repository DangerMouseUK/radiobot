-- Deleting a station or a source makes SQLite find the rows that point to it (ON DELETE CASCADE).
-- These columns weren't indexed (each table's primary key starts with guild_id or id), so every
-- such delete read the whole table. Adds indexes only: no data changes.

CREATE INDEX ix_guild_favourites_station ON guild_favourites (station_id);
CREATE INDEX ix_guild_queue_station ON guild_queue (station_id);
CREATE INDEX ix_guild_source_preferences_station ON guild_source_preferences (station_id);
CREATE INDEX ix_guild_source_preferences_source ON guild_source_preferences (preferred_source_id);
