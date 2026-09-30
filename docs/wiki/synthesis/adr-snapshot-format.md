---
type: synthesis
kind: decision
title: "ADR: snapshot format: flattened customer records, cumulative deltas, detached Ed25519 signatures"
tags: [distribution, data]
created: 2026-09-30
updated: 2026-09-30
sources: []
status: accepted
decided: 2026-09-30
---

# ADR: snapshot format: flattened customer records, cumulative deltas, detached Ed25519 signatures

## Context

Snapshots must stay readable by standard MaxMind DB readers (AGENTS.md domain rules). They carry only the customer verdict view: shippable signals only, reasons without source or prefix (constitution v3.0.0, [[adr-customer-facing-behavior-data]]). Deltas are published every hour, and a client may miss some of them.

## Decision

- **Flattened customer records.** The builder collects the network, shippable category and behaviour prefixes plus the special-purpose ranges. It sweeps their boundaries into elementary ranges, scores each distinct signal set once, merges neighbours with the same record and writes the ranges as CIDRs. A record is `{risk, level, categories, reasons: [{code, last_seen, contribution}], network: {asn?, org?, country?}}`. There is no prefix in the record: the reader already returns the matched network, and per-record prefixes would defeat the data-section deduplication.
- **One IPv6 tree** with IPv4 at `::/96` and `::ffff:0:0/96` aliased to it, so readers find IPv4-mapped addresses. IPv6 data inside those two ranges is clipped out.
- **Cumulative deltas.** A delta holds every range whose record changed since the day's full snapshot, and `{removed: true}` tombstones for ranges that lost their record. A client needs only the full snapshot and the latest delta, and a missed delta costs nothing. The builder keeps each full snapshot's range table (gzipped JSON lines) in its private work directory to compute the diff.
- **Detached raw Ed25519 signatures.** `<file>.sig` is the 64-byte signature of the exact file bytes, verifiable with `openssl pkeyutl -verify -rawin`. The key id is the first 8 hex digits of the sha256 of the raw public key. The manifest, the key list and the archive index are signed the same way.
- **The `/v1/` layout**: `manifest.json`, `keys.json`, `full/`, `delta/`, `archive/index.json`, `reports/`. Published files are immutable, and every release gets a report ([[adr-category-only-cap]] explains why category-only risk never reaches `high`).
- **Validation before publication.** The file must read back with the in-house reader and fit the 250 MB budget. A sample of addresses, including addresses with local-only data, must match the customer verdict computed from the database. The licence notices of every contributing source must be on record.

## Options considered

- **A MaxMind-style database per data type** (one for categories, one for behaviour): pushes the scoring onto every client, and clients would have to agree on the algorithm version.
- **Chained hourly deltas** (each over the previous delta): smaller files, but one missed file breaks the chain.
- **Signatures inside the MMDB metadata**: standard readers ignore them, and the signed bytes would have to exclude the signature.
- **JWS or minisign**: a format or tool dependency for 64 bytes.

## Consequences

Standard readers agree with our reader (SC-001, `tests/perf/second-reader.measure.ts`). The last-seen time of built-in special-purpose bogons is the build time, so each delta repeats those ranges; they are few. Tests: `tests/acceptance/us1-snapshot.test.ts`. Code: `src/snapshot/`, `src/mmdb/`. Topology: [[adr-publication-topology]].
