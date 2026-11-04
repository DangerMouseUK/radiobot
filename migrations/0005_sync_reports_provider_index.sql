-- The last sync of a pack is looked up by pack, newest first, and each new report trims that
-- pack's history. Without an index on the pack every such lookup read the whole table; with one
-- it reads only that pack's rows. Adds an index only: no data changes.

CREATE INDEX ix_sync_reports_provider ON catalogue_sync_reports (provider, id);
