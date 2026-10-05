---
type: synthesis
kind: decision
title: "ADR: history model and retention for stored signals"
tags: [storage, scoring]
created: 2026-09-24
updated: 2026-10-05
sources: []
status: accepted
decided: 2026-09-24
---

# ADR: history model and retention for stored signals

## Context

A verdict for a past date must be reproducible from stored data (constitution Principle II, spec FR-004 and FR-028–FR-031). Behavior observations are numerous and close to personal data, so they need a retention period (Principle IV).

## Decision

- **Categories and network info** are validity intervals of the form `(prefix cidr, code/asn, source, valid tstzrange)`, kept forever.
  - A successful feed run opens an interval when a prefix appears and closes it when the prefix disappears.
  - A category signal's `lastSeen` (Principle III) is the latest successful run of its feed at or before the evaluation time, read from `feed_run`. Every such run since the interval opened listed the prefix, or it would have closed. The interval stores `last_seen` once, when it closes. Until 2026-10-05 every run rewrote `last_seen` on all open rows of its feed, which bloated the table and its indexes (cymru-fullbogons: 160k rows per run).
  - Indexes: GiST `(prefix inet_ops, valid)`, plus a partial unique index `WHERE upper_inf(valid)`.
- **Raw behavior observations** are stored as listing episodes: one row per continuous listing of `(prefix, code, source)`. Feeds that give their own timestamps (Feodo) get one row per distinct time instead.
  - One row per run would be about 65 M rows in 90 days for blocklist.de alone.
  - Episodes lose nothing, because the runs themselves are recorded in `feed_run`.
- **Daily aggregates** `(prefix, code, source, day, count, first/last seen, confidence)` are written in the same transaction as the raw rows. Reading raw rows or aggregates therefore gives the same current verdict (FR-030).
- **Retention:**

  | Data | Kept for |
  |------|----------|
  | Raw behavior observations | 90 days |
  | Daily aggregates | 365 more days (455 days in total) |
  | Fetched feed artifacts | 30 days |
  | Category and network intervals | forever |

  Both behavior periods are configurable in the scoring config.
- **Retention check:** a scoring config is rejected if any behavior code, at weight and confidence 1, would still add ≥ 0.5 risk points when its data is deleted. This limits half-lives to about 1,429 h (FR-029a).
- **Incomplete history:** verdicts carry `behaviorHistoryIncomplete` when deleted data could still have mattered at the evaluation time.
- **Data versions:** every write transaction creates a data version that pins the scoring algorithm version and config. Lookups run in one `REPEATABLE READ` snapshot.

## Consequences

- Past verdicts are exact within the raw window, and exact to the day beyond it.
- Stage 2 snapshots are archived separately, so a client's past view can be reloaded exactly.
- Code: `db/migrations/0001_init.sql`, `db/migrations/0004_category_last_seen_at_close.sql`, `src/ingest/apply.ts`, `src/lookup/signals.ts`, `src/snapshot/ranges.ts`, `src/retention/retention.ts`.
