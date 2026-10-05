---
type: synthesis
kind: decision
title: "ADR: scenario logic in memory, PostgreSQL per query path, parallel test files"
tags: [testing]
created: 2026-10-05
updated: 2026-10-05
sources: []
status: accepted
decided: 2026-10-05
---

# ADR: scenario logic in memory, PostgreSQL per query path, parallel test files

## Context

On 2026-10-05 the acceptance and security tests took about 250 s. Measured causes:

- **N+1 queries.** Evaluations and snapshot validation scored addresses one by one, with four sequential queries each. That made thousands of round trips at about 0.75 ms each, through Docker Desktop on Windows.
- **Scoring through the database.** Most lookup scenarios wrote their rows into PostgreSQL only to read them back, although they checked scoring.
- **Duplicates.** Every scenario ran for IPv4 and IPv6 (SC-008), including those where the family changes nothing.
- **Per-row foreign keys.** Checks on run references cost about a third of every feed apply ([[adr-postgresql-storage]]).
- **One file at a time.** Test files ran sequentially, although each file already has its own database.

The project rule still holds: tests cover user scenarios and security issues only (AGENTS.md).

## Decision

- **Decisions are pure; queries select.** Rules such as a signal's lastSeen live in TypeScript (`src/lookup/rules.ts`, `buildVerdict` in `src/lookup/lookup.ts`). SQL only selects the rows valid at T. Lookups and snapshots share one copy of each rule.
- **Scenarios run in memory.** `tests/helpers/signals.ts` models the row selection over the scenario rows and applies the same rules.
- **One PostgreSQL scenario per query path.** Each query path (containment per family, time travel, closed intervals, episodes, network) keeps one scenario marked `"layer": "sql"` against PostgreSQL. These scenarios also keep the in-memory model honest.
- **What stays on PostgreSQL.** Set operations stay there: the ingest diff, retention and sampling. So do the database guarantees: one data version per verdict, and parameter binding.
- **End-to-end tests.** At most one end-to-end test per CLI command or service.
- **Address family.** Both families are tested where the family changes the behavior: parsing, prefix storage and containment, network data, snapshots. State over time (holds, failed updates, retention, re-runs, transactions) is tested once. SC-008 was amended accordingly.
- **Minimal fixtures.** A test loads only the fixture feeds its scenario needs (`loadFixtureFeeds`). The full dataset (about 1.3 s) stays for tests that check every feed, such as the snapshot contents.
- **`/verify` and policy tests use a recorded snapshot.** `/verify` reads only the published files.
- **Parallel files.** `bun test --parallel=8` runs the files in parallel. Test pools are capped (admin 1, file 4 connections) to stay under the server's 100 connections.

## Consequences

- The suite takes about 9 s instead of about 250 s. The longest files (feed ingestion, the archive) set the floor.
- A rule change shows up in milliseconds in the in-memory scenarios. Breaking the category lastSeen rule fails ten tests, the in-memory ones included.
- Production benefits from the same work: batched reads in evaluations and release reports, one round trip per lookup, and cheaper applies.
- Alert tests still check their decisions through database cycles. They take about 1 s per file, so moving those decisions into memory is not worth it.
