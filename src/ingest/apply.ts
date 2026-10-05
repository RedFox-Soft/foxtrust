import type { SQL } from "bun";
import { createDataVersion, type DataVersion } from "../db/versions";
import type { BehaviorEntry, FeedDefinition, NetworkEntry, ParsedEntry } from "../feeds/types";

const BATCH = 20_000;

export type ApplyCounts = { opened: number; closed: number; refreshed: number };

type IncomingRow = {
  prefix: string;
  code: string | null;
  asn: number | null;
  org: string | null;
  country: string | null;
  observed_at: Date | null;
  confidence: number | null;
};

function toRow(entry: ParsedEntry): IncomingRow {
  const network = entry as NetworkEntry;
  const behavior = entry as BehaviorEntry;
  return {
    prefix: entry.prefix,
    code: "code" in entry ? entry.code : null,
    asn: "asn" in entry ? network.asn : null,
    org: "org" in entry ? network.org : null,
    country: "country" in entry ? network.country : null,
    observed_at: behavior.observedAt ?? null,
    confidence: behavior.confidence ?? null,
  };
}

async function loadIncoming(tx: SQL, entries: ParsedEntry[]): Promise<void> {
  await tx`CREATE TEMP TABLE incoming (
    prefix cidr NOT NULL, code text, asn bigint, org text, country char(2),
    observed_at timestamptz, confidence real
  ) ON COMMIT DROP`;
  // Values are bound parameters; feed text never becomes SQL (research R14).
  // Each batch is one JSON parameter, so the statement text never changes with the batch size:
  // Bun keeps one named prepared statement per distinct text on every pooled connection, and a
  // `VALUES` list per size piled up gigabytes of cached plans in the long-running scheduler.
  // `::text` first: a `::jsonb` parameter makes Bun encode the string as a JSON string literal.
  for (let i = 0; i < entries.length; i += BATCH) {
    const rows = JSON.stringify(entries.slice(i, i + BATCH).map(toRow));
    await tx`
      INSERT INTO incoming (prefix, code, asn, org, country, observed_at, confidence)
      SELECT prefix, code, asn, org, country, observed_at, confidence
      FROM jsonb_to_recordset(${rows}::text::jsonb) AS r (
        prefix cidr, code text, asn bigint, org text, country char(2),
        observed_at timestamptz, confidence real)`;
  }
  await tx`CREATE INDEX ON incoming (prefix, code)`;
  await tx`ANALYZE incoming`;
}

const count = (result: { count?: number }[] & { count?: number }) => Number(result.count ?? 0);

async function applyNetwork(tx: SQL, source: string, runId: number): Promise<ApplyCounts> {
  const closed = await tx`
    UPDATE network_interval ni
    SET valid = tstzrange(lower(ni.valid), now(), '[)'), closed_run_id = ${runId}
    WHERE ni.source = ${source} AND upper_inf(ni.valid)
      AND NOT EXISTS (
        SELECT 1 FROM incoming i
        WHERE i.prefix = ni.prefix AND i.asn IS NOT DISTINCT FROM ni.asn
          AND i.org IS NOT DISTINCT FROM ni.org AND i.country IS NOT DISTINCT FROM ni.country)`;
  const opened = await tx`
    INSERT INTO network_interval (prefix, asn, org, country, source, valid, opened_run_id)
    SELECT DISTINCT ON (i.prefix) i.prefix, i.asn, i.org, i.country, ${source}, tstzrange(now(), NULL, '[)'), ${runId}
    FROM incoming i
    WHERE NOT EXISTS (
      SELECT 1 FROM network_interval ni
      WHERE ni.source = ${source} AND upper_inf(ni.valid) AND ni.prefix = i.prefix)
    ORDER BY i.prefix`;
  return { opened: count(opened), closed: count(closed), refreshed: 0 };
}

/**
 * Open intervals are not touched while the feed keeps listing them: their lastSeen is the feed's
 * latest successful run (lookup/signals.ts). A closing interval stores the last run that listed it,
 * the latest successful run before this one, whose own `committed_at` is not set yet.
 */
async function applyCategory(tx: SQL, source: string, runId: number, shippable: boolean): Promise<ApplyCounts> {
  const closed = await tx`
    UPDATE category_interval ci
    SET valid = tstzrange(lower(ci.valid), now(), '[)'), closed_run_id = ${runId},
        last_seen = GREATEST(lower(ci.valid), (
          SELECT max(fr.committed_at) FROM feed_run fr
          WHERE fr.feed_id = ${source} AND fr.status IN ('applied', 'unchanged')))
    WHERE ci.source = ${source} AND upper_inf(ci.valid)
      AND NOT EXISTS (SELECT 1 FROM incoming i WHERE i.prefix = ci.prefix AND i.code = ci.code)`;
  const opened = await tx`
    INSERT INTO category_interval (prefix, code, source, valid, opened_run_id, shippable)
    SELECT DISTINCT i.prefix, i.code, ${source}, tstzrange(now(), NULL, '[)'), ${runId}, ${shippable}
    FROM incoming i
    WHERE NOT EXISTS (
      SELECT 1 FROM category_interval ci
      WHERE ci.source = ${source} AND upper_inf(ci.valid) AND ci.prefix = i.prefix AND ci.code = i.code)`;
  return { opened: count(opened), closed: count(closed), refreshed: 0 };
}

/** Listing episodes: extend while listed, close when absent, start anew when listed again. */
async function applyBehaviorRun(tx: SQL, source: string, runId: number, shippable: boolean): Promise<ApplyCounts> {
  const closed = await tx`
    UPDATE behavior_sighting s SET open = false
    WHERE s.source = ${source} AND s.open
      AND NOT EXISTS (SELECT 1 FROM incoming i WHERE i.prefix = s.prefix AND i.code = s.code)`;
  const refreshed = await tx`
    UPDATE behavior_sighting s
    SET last_seen = now(), sightings = s.sightings + 1, last_run_id = ${runId},
        confidence = COALESCE(i.confidence, s.confidence)
    FROM (SELECT prefix, code, max(confidence) AS confidence FROM incoming GROUP BY prefix, code) i
    WHERE s.source = ${source} AND s.open AND s.prefix = i.prefix AND s.code = i.code`;
  const opened = await tx`
    INSERT INTO behavior_sighting (prefix, code, source, first_seen, last_seen, recorded_at, sightings,
                                   first_run_id, last_run_id, open, feed_time, confidence, shippable)
    SELECT i.prefix, i.code, ${source}, now(), now(), now(), 1, ${runId}, ${runId}, true, false,
           max(i.confidence), ${shippable}
    FROM incoming i
    WHERE NOT EXISTS (
      SELECT 1 FROM behavior_sighting s
      WHERE s.source = ${source} AND s.open AND s.prefix = i.prefix AND s.code = i.code)
    GROUP BY i.prefix, i.code
    ON CONFLICT (source, code, prefix, first_seen) DO NOTHING`;
  await tx`
    INSERT INTO behavior_daily (prefix, code, source, day, count, first_seen, last_seen, confidence, shippable)
    SELECT i.prefix, i.code, ${source}, (now() AT TIME ZONE 'UTC')::date, 1, now(), now(), max(i.confidence), ${shippable}
    FROM incoming i
    GROUP BY i.prefix, i.code
    ON CONFLICT (prefix, code, source, day) DO UPDATE
    SET count = behavior_daily.count + 1,
        first_seen = LEAST(behavior_daily.first_seen, EXCLUDED.first_seen),
        last_seen = GREATEST(behavior_daily.last_seen, EXCLUDED.last_seen),
        confidence = COALESCE(EXCLUDED.confidence, behavior_daily.confidence)`;
  return { opened: count(opened), closed: count(closed), refreshed: count(refreshed) };
}

/** Feed-provided times: one row per distinct observation time; re-reading the same time is a no-op. */
async function applyBehaviorFeedTime(tx: SQL, source: string, runId: number, shippable: boolean): Promise<ApplyCounts> {
  const rows = await tx`
    WITH new_rows AS (
      INSERT INTO behavior_sighting (prefix, code, source, first_seen, last_seen, recorded_at, sightings,
                                     first_run_id, last_run_id, open, feed_time, confidence, shippable)
      SELECT i.prefix, i.code, ${source}, i.observed_at, i.observed_at, now(), 1, ${runId}, ${runId}, false, true,
             max(i.confidence), ${shippable}
      FROM incoming i
      WHERE i.observed_at IS NOT NULL
      GROUP BY i.prefix, i.code, i.observed_at
      ON CONFLICT (source, code, prefix, first_seen) DO NOTHING
      RETURNING prefix, code, first_seen, confidence
    ), daily AS (
      INSERT INTO behavior_daily (prefix, code, source, day, count, first_seen, last_seen, confidence, shippable)
      SELECT prefix, code, ${source}, (first_seen AT TIME ZONE 'UTC')::date, count(*), min(first_seen), max(first_seen),
             max(confidence), ${shippable}
      FROM new_rows
      GROUP BY prefix, code, (first_seen AT TIME ZONE 'UTC')::date
      ON CONFLICT (prefix, code, source, day) DO UPDATE
      SET count = behavior_daily.count + EXCLUDED.count,
          first_seen = LEAST(behavior_daily.first_seen, EXCLUDED.first_seen),
          last_seen = GREATEST(behavior_daily.last_seen, EXCLUDED.last_seen),
          confidence = COALESCE(EXCLUDED.confidence, behavior_daily.confidence)
      RETURNING 1
    )
    SELECT (SELECT count(*) FROM new_rows) AS opened`;
  return { opened: Number(rows[0]?.opened ?? 0), closed: 0, refreshed: 0 };
}

/**
 * Makes every stored signal of a feed follow its shippable status, so a licence or `ship`
 * change reaches the customer view at once (constitution II: `ship: no` withdraws a feed).
 * Creates a data version when any row changed.
 */
export async function setShippable(tx: SQL, def: FeedDefinition, runId: number, shippable: boolean): Promise<DataVersion | null> {
  if (def.kind === "network") return null;
  const updated = def.kind === "category"
    ? count(await tx`UPDATE category_interval SET shippable = ${shippable} WHERE source = ${def.id} AND shippable <> ${shippable}`)
    : count(await tx`UPDATE behavior_sighting SET shippable = ${shippable} WHERE source = ${def.id} AND shippable <> ${shippable}`)
      + count(await tx`UPDATE behavior_daily SET shippable = ${shippable} WHERE source = ${def.id} AND shippable <> ${shippable}`);
  return updated > 0 ? createDataVersion(tx, { cause: "feed_run", feedRunId: runId }) : null;
}

/**
 * Identifies a feed version by its parsed entries in feed order, so a file that only changes its
 * header, comments or formatting is `unchanged`, and a parser change applies even to an old file.
 */
export function entriesSha256(entries: ParsedEntry[]): string {
  const hasher = new Bun.CryptoHasher("sha256");
  for (const entry of entries) hasher.update(JSON.stringify(toRow(entry))).update("\n");
  return hasher.digest("hex");
}

/**
 * Applies one feed version inside the caller's transaction and creates its data version.
 * Every bound written here is the transaction timestamp (research R7).
 * An `unchanged` version writes nothing but the data version, except for listing episodes, which
 * record the run as a sighting: intervals and feed-time rows already hold exactly these entries,
 * and a category's lastSeen follows from the run itself.
 */
export async function applyEntries(
  tx: SQL,
  def: FeedDefinition,
  runId: number,
  entries: ParsedEntry[],
  shippable: boolean,
  unchanged = false,
): Promise<{ version: DataVersion; counts: ApplyCounts }> {
  const listingEpisodes = def.kind === "behavior" && def.timestamps === "run";
  if (unchanged && !listingEpisodes) {
    const version = await createDataVersion(tx, { cause: "feed_run", feedRunId: runId });
    return { version, counts: { opened: 0, closed: 0, refreshed: 0 } };
  }
  await loadIncoming(tx, entries);
  let counts: ApplyCounts;
  if (def.kind === "network") counts = await applyNetwork(tx, def.id, runId);
  else if (def.kind === "category") counts = await applyCategory(tx, def.id, runId, shippable);
  else if (def.timestamps === "feed") counts = await applyBehaviorFeedTime(tx, def.id, runId, shippable);
  else counts = await applyBehaviorRun(tx, def.id, runId, shippable);

  const version = await createDataVersion(tx, { cause: "feed_run", feedRunId: runId });
  return { version, counts };
}
