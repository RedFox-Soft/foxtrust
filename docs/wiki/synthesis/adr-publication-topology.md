---
type: synthesis
kind: decision
title: "ADR: publish snapshots from our own server; verifiers pin keys"
tags: [architecture, distribution]
created: 2026-09-30
updated: 2026-10-08
sources: []
status: accepted
decided: 2026-09-30
---

# ADR: publish snapshots from our own server; verifiers pin keys

## Context

Stage 2 publishes the customer verdict as signed snapshot files. Customers' `/verify` services download them in the background. The files are public (they list addresses, so a dispute path must exist first: `docs/dispute.md`). The private signing key must stay in one place, and a verifier must not trust a file only because it came from the right URL.

## Decision

- **Our own publication server.** `foxtrust publication serve` is a read-only static server (GET/HEAD only, no listing, no path outside `v1/`), behind the operator's TLS proxy. The `/v1/` layout is stable, so a CDN can be put in front later without changing clients.
- **Three containers from one image** (`docker-compose.yml`):
  - `scheduler`: ingestion, the snapshot jobs (full `50 4 * * *`, delta `50 * * * *`, archive retention `15 4 * * *`, all under the advisory lock `snapshot`) and the only copy of the signing key;
  - `publication`: serves the publication volume read-only;
  - `verify`: the forward-auth service. It has no database and no key.
  - `api` (added 2026-10-07): the public API, answering from the same published snapshot ([[adr-public-api]]).
  - `admin` (added 2026-10-08): the operator panel, with no host port and no key; held releases it requests are published by the scheduler ([[adr-admin-panel]]).
- **The signing key is a Docker secret** (`FOXTRUST_SIGNING_KEY=/run/secrets/signing_key`), mounted only into `scheduler`. It is never committed. Without it the scheduler still ingests and says that the snapshot jobs are disabled.
- **Verifiers pin keys.** `/verify` trusts only the base64 Ed25519 keys in `FOXTRUST_TRUSTED_KEYS`. `v1/keys.json` in the publication is informational. Rotation: publish the new key, let verifiers trust both, switch the signing key, then remove the old key from the verifiers.
- **Transport:** `http://` is allowed for the publication URL, because integrity comes from the signatures and the manifest's sha256 and size, not from TLS.

## Options considered

- **Object storage or a CDN from the start**: adds an account and credentials before there are customers. The stable `/v1/` layout keeps this option open.
- **A separate builder container**: would need its own database credentials and a second copy of the key.
- **Trust keys from `keys.json`**: an attacker who can change the publication could then add their own key.

## Consequences

A compromised publication host can at most withhold updates: `/verify` keeps its last good data, reports `lastError` and becomes `stale` after `FOXTRUST_MAX_AGE_HOURS`. Tests: `tests/acceptance/us2-verify-updates.test.ts` (updates, outage, key rotation), `tests/security/snapshot-integrity.test.ts`, `tests/security/publication-server.test.ts`. Code: `src/publication/`, `src/verify/`, `src/snapshot/publish.ts`. Record format: [[adr-snapshot-format]].
