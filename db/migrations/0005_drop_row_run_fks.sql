-- Run references on intervals and episodes are written only by ingest, from the run it is applying
-- in the same transaction, and feed_run rows are never deleted. Their foreign keys cost one lookup
-- per inserted or updated row (about a third of an apply; every hourly blocklist.de run refreshes
-- all open episodes), so the constraints go and the columns stay.
ALTER TABLE network_interval
  DROP CONSTRAINT network_interval_opened_run_id_fkey,
  DROP CONSTRAINT network_interval_closed_run_id_fkey;
ALTER TABLE category_interval
  DROP CONSTRAINT category_interval_opened_run_id_fkey,
  DROP CONSTRAINT category_interval_closed_run_id_fkey;
ALTER TABLE behavior_sighting
  DROP CONSTRAINT behavior_sighting_first_run_id_fkey,
  DROP CONSTRAINT behavior_sighting_last_run_id_fkey;
