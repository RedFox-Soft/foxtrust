---
type: synthesis
kind: decision
title: "ADR: PostgreSQL with inet/cidr and GiST for storage"
tags: [storage]
created: 2026-10-05
updated: 2026-10-05
sources: []
status: accepted
decided: 2026-09-24
---

# ADR: PostgreSQL with inet/cidr and GiST for storage

## Context

The core query is "which stored prefixes contain this address, and what was valid at time T". It runs for every lookup, and over every row when a snapshot is built. Feeds deliver prefixes of any length, IPv4 and IPv6 mixed.

## Decision

- **PostgreSQL**, not MongoDB or a key-value store. Addresses and ranges use the native `inet`/`cidr` types. Containment (`prefix >>= addr`) is answered by GiST indexes `(prefix inet_ops, valid)` directly, without converting addresses to integers or text.
- Validity in time is a `tstzrange` in the same GiST index, so a past evaluation time costs the same as now ([[adr-history-and-retention]]).
- No ORM and no driver dependency: the built-in `Bun.sql` client.
- The constitution makes this binding: addresses and ranges MUST use `inet`/`cidr`, range lookups MUST be index-backed.

## Consequences

- One database holds intervals, behavior episodes, aggregates, feed runs, data versions and snapshot releases, and one transaction keeps them consistent.
- Snapshot distribution does not depend on the database: clients read MMDB files ([[adr-snapshot-format]]).
- Operational lessons from production are in [[2026-10-05-production-database-review]].
- Code: `db/migrations/`, `src/db/client.ts`.
