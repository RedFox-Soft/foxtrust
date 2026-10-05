---
type: synthesis
title: "Production database review (2026-10-05)"
tags: [storage, operations, open-question]
created: 2026-10-05
updated: 2026-10-05
sources: []
---

# Production database review (2026-10-05)

The question was why the production database ([[adr-production-hosting]]) "grew so much" after one day of ingestion. All numbers below were measured on production with read-only queries unless a fix is named.

## Size is data, not history

| Table | Rows | Total | Note |
|-------|------|-------|------|
| `network_interval` | 1.50 M | 347 MB | the full [[iptoasn]] table; 8 k closed rows |
| `category_interval` | 215 k | 129 MB | [[cymru-fullbogons]] 161 k, [[x4bnet-datacenter]] 53 k, [[tor-exit]] 1.4 k |
| everything else | | < 5 MB | |

The database was 488 MB, plus 192 MB of WAL. 99 % of the rows are current data. The interval diff works: an [[iptoasn]] run closes and opens about 2 k rows. Slightly more than half of the size is GiST and B-tree indexes, the cost of answering containment queries in the database ([[adr-postgresql-storage]]).

## Cached plans leaked memory in the scheduler's connections

The database container used 7.2 GB, although `shared_buffers` was 128 MB. Four idle scheduler connections held about 1.8 GB each, in 76 cached plans of up to 22 MB.

- **Cause**: ingest inserted batches as a `VALUES` list with one parameter per cell. A batch of 5 000 rows × 7 columns has up to 35 000 parameters. The SQL text changed with the batch size, and the size of a feed's last batch changes almost every run.
  - `Bun.sql` keeps one named prepared statement per distinct text, on every pooled connection, for as long as the connection lives.
  - The scheduler's pool never closes its connections.
- **Fix** (foxtrust `b0b1c0e`): each batch goes in as one JSON parameter through `jsonb_to_recordset(${json}::text::jsonb)`. There is now one statement whatever the size.
  - The `::text` cast is needed: with `::jsonb` alone, Bun encodes the JS string as a JSON string literal.
  - Loading speed is unchanged, and values stay bound parameters.
  - After the next [[iptoasn]] run (1.49 M rows) the largest connection held 18 MB and the container 215 MB.
- **Rejected safety net**: Bun 1.4.2's pool options `idleTimeout` and `maxLifetime` close a connection even while a query runs or while it is reserved. That would drop the feed advisory lock held on a reserved connection in `runFeed`. Tested locally; neither is set.
- **Rule**: dynamic-shape SQL (bulk `VALUES`, IN lists of varying length) must keep a fixed text. When memory grows, check `pg_prepared_statements` on one connection.

## Every run rewrote all open category rows

- Every successful run, including `unchanged` runs, set `last_seen = now()` on all open intervals of its feed. That came to about 1.05 M updates in a day on 215 k rows, and 0.4 % of them were HOT.
- [[cymru-fullbogons]] was "applied" six times with no changes: the file's hash changed, the data did not.
- The indexes were 3–4 times their fresh size (83 MB, 34 MB after `REINDEX CONCURRENTLY`), and the database wrote about 1.9 GB of WAL a day.
- **Fix** (foxtrust `f7efdf9`, migration 0004): a category signal's `lastSeen` is the feed's latest successful run at or before the evaluation time, read from `feed_run`. The interval stores `last_seen` only when it closes ([[adr-history-and-retention]]).
  - The old and new rules agreed for all 215 k intervals at three evaluation times on production data.
  - `fillfactor` with HOT updates was rejected: it would still write 160 k rows and their WAL per run.

## Interval history stays

- Closed intervals grow by about 8 k rows a day, roughly 0.7 GB a year.
- The spec keeps category and network intervals forever (FR-028, R9). Past verdicts depend on them; archived snapshots do not.
- Revisit when closed rows outnumber open ones, or when the database passes about 5 GB. Then split current and historical rows: LIST partitions on `upper_inf(valid)`, so lookups at "now" read only the small partition.

## Postgres ran on image defaults

The defaults were `shared_buffers` 128 MB, `work_mem` 4 MB and `maintenance_work_mem` 64 MB, with no WAL compression. Ingest spilled 1.3 GB of temporary files a day. `homeserver/stacks/foxtrust/compose.yaml` now sets:

- `shared_buffers=1GB` and `effective_cache_size=4GB`;
- `work_mem=32MB` and `maintenance_work_mem=256MB`;
- `random_page_cost=1.1` and `wal_compression=lz4`;
- `shm_size: 256mb`;
- memory limits: 4 GB for the database and 3 GB for the scheduler, whose [[iptoasn]] run peaks at about 1 GB.

## Open follow-ups

- ~~Skip the full apply on `unchanged` runs.~~ Done 2026-10-05: an unchanged version of a network, category or feed-time behavior feed writes only its `feed_run` row and data version. Listing-episode behavior feeds still refresh their episodes.
- ~~Detect "unchanged" from the parsed entries rather than the file hash.~~ Done 2026-10-05: `content_sha256` is the SHA-256 of the parsed entries in feed order. A [[cymru-fullbogons]] file that changes only its header is `unchanged`, and a parser change applies even to an old file. Hashing 1.49 M entries takes about 1.7 s.
- Alert on the database container's memory, not only the host's 85 %.
