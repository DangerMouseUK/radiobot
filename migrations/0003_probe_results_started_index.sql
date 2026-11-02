-- The hourly clean-up deletes check results older than PROBE_HISTORY_DAYS by start time.
-- Without an index on that column it read the whole table every hour; with one it reads only
-- the rows it deletes. Adds an index only: no data changes.

CREATE INDEX ix_probe_results_started ON source_probe_results (started_at);
