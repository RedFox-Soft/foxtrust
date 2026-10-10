---
type: synthesis
kind: decision
title: "ADR: public API v1 from the published snapshot, with keys and per-key limits"
tags: [distribution, architecture]
created: 2026-10-07
updated: 2026-10-10
sources: []
status: accepted
decided: 2026-10-07
---

# ADR: public API v1 from the published snapshot, with keys and per-key limits

Decision for backlog item B-10 (spec 010). It adds a fourth container to the stack of [[adr-publication-topology]].

**Problem**: the customer verdict reached customers only as snapshot files and through `/verify`. Developers who want one answer per address need an HTTP API with keys and a free tier that a home server can afford.

## Decision

| Topic | Choice | Why |
|-------|--------|-----|
| Data source | The `api` service loads the published, signed snapshot with the `/verify` loader (full + delta, hourly checks) and answers from memory | API, SDK and `/verify` give the same answer for the same version; the release gate (Principle VI) applies; no public load on, or path to, the database. Cost: data up to about an hour old |
| Answer | Customer view of the snapshot record (risk, level, categories, reasons with code, `lastSeen`, contribution; network without prefix), plus `data {version, delta, builtAt, stale}` and the manifest's `disputeUrl`. Schema `schemas/api-ip-v1.schema.json`, every object closed | An answer can be reproduced from the named snapshot; no field can carry a source or a reason prefix (Principle II) |
| Keys | `ftk_<id>_<secret>`: a 12-character public id, 256 random bits of secret; only SHA-256 of the secret is stored, compared in constant time. Header `Authorization: Bearer` or `X-API-Key`; a key in the query string gets `400` | The id lets people discuss a key without the secret; a random 256-bit secret needs no slow hash; keys in URLs end up in proxy logs |
| Key changes | Active keys held in memory, reloaded every 30 s (one query); unknown ids get `401` without a query | Revocation and new keys take effect within a minute; lookups never wait for the database |
| Limits | Per key: a token bucket (free tier 5/s) and a UTC-day quota (1,000), both configurable and overridable per key. Counted in memory per instance, flushed every 10 s; today's counts are read back at start | No write per lookup; a restart does not refill a quota. Only answered lookups use the quota |
| Usage and logs | `api_usage_daily(key_id, day, answered, invalid, limited)`, kept 400 days; no per-request log line, one summary per minute | The queried addresses are customers' visitors' addresses: Principle IV forbids collecting them without opt-in |
| Accounts | Every key belongs to an account. `src/api/accounts.ts` is the only code that touches the three tables. Decided 2026-10-08 for B-15: an account becomes one foxauth user (`issuer` + `subject`), created at the first sign-in. Decided 2026-10-10: only by self-registration, and FoxTrust stores no name or email (foxauth holds and deletes them; spec 012) | The site (B-15) and the admin panel (B-16, [[adr-admin-panel]]) build on one service; identity, passwords and second factors stay in foxauth |
| No key CLI | The only new command is `api serve`. Account and key commands were dropped on 2026-10-07 | The admin panel and the site come next; a CLI would be a third interface to maintain. Until then, keys are issued with a one-off call to the service |

## Measurements (2026-10-07, fixture data)

- **SC-003**: 1,000 of 1,000 addresses, listed and unlisted, in both families, gave the same answer through the API as through a standard MMDB reader on the same file.
- **SC-004**: p95 1.31 ms (p50 0.72 ms) at 200 lookups/s on the development machine. It is still to be measured on the production host.

## Limits

- **One instance**: limit counters are per instance. A second instance would double each key's effective limits until counting moves to the database.
- **Crash window**: up to 10 s of usage counts can be lost on a crash; quotas are generous enough for this.
- **Keys in public pages**: CORS is open for `GET`, so a key embedded in a web page can be copied. The docs advise server-side use; revocation is the remedy.

## Alternatives rejected

- **Live lookups from PostgreSQL**: fresher, but they bypass the release gate, differ from the published snapshot, and put public load on the database.
- **OAuth client credentials for API clients** (foxauth): a token exchange before a single lookup is friction that comparable services avoid; limits and usage would still live in FoxTrust. foxauth is used to sign people into the site and the admin panel instead (B-15, B-16).
- **A database write per lookup** for exact counts across instances: one instance is planned.
- **An access log with addresses** for abuse forensics: Principle IV.
