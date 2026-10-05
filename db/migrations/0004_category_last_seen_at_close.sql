-- category_interval.last_seen is written once, when the interval closes (the last run that listed the
-- prefix). While an interval is open its lastSeen is the feed's latest successful run in feed_run, so a
-- run no longer rewrites every open row of its feed (specs/001-core-ip-lookup/data-model.md).
ALTER TABLE category_interval ALTER COLUMN last_seen DROP NOT NULL;
UPDATE category_interval SET last_seen = NULL WHERE upper_inf(valid);
