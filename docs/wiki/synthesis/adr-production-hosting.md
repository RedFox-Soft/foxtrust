---
type: synthesis
kind: decision
title: "ADR: production on the home server, images built on the PC"
tags: [operations]
created: 2026-10-05
updated: 2026-10-05
sources: []
status: accepted
decided: 2026-10-04
---

# ADR: production on the home server, images built on the PC

## Context

Ingestion has to run unattended, so that history accumulates and the data stays fresh. FoxTrust has no public API yet, so production does not need a public endpoint or high availability. A home Docker server (`geekom`, Ubuntu 26.04) already exists. Its configuration lives in the separate `homeserver` repository.

## Decision

- **Where**: the stack `/opt/stacks/foxtrust` on `geekom`. It runs its own `postgres:18.6-alpine` with no published port, plus the scheduler image. Publication and `/verify` ([[adr-publication-topology]]) are not deployed yet. There is no signing key yet, so the scheduler only ingests.
- **Images only on the server**: an image is built on the PC from a committed revision with `git archive`, so uncommitted changes never ship. It is streamed over SSH with `docker save | docker load`. The server has no source checkout, no registry and no CI.
- **One command to deploy and roll back**: in the `homeserver` repository, `bash stacks/foxtrust/deploy.sh [revision]` does the following:
  1. builds and uploads the image if the server does not have it yet;
  2. copies `compose.yaml`;
  3. waits until no feed run holds its advisory lock;
  4. switches `FOXTRUST_TAG` and waits for the scheduler healthcheck, rolling back to the previous tag if the check fails;
  5. keeps only the new and the previous image.

  Deploying an older revision is the rollback.
- **Server configuration** lives in `homeserver/stacks/foxtrust/compose.yaml`: Postgres settings, memory limits and the Tor mirror URL. That repository is the source of truth.
- **Egress**: the server's ISP blocks `torproject.org`, so [[tor-exit]] reads the CC0 exit lists through a Cloudflare Worker mirror (`FOXTRUST_TOR_EXIT_URL`).
- **Monitoring**:
  - host metrics and alerts come from Beszel, which posts to Telegram;
  - pipeline alerts come from [[adr-operator-alerts]], which stays off until the bot token and chat id are set on the server.

## Consequences

- Migrations run when the container starts. A rollback does not undo them, so a migration must keep the previous image working.
- Backups (a `pg_dump` sent off-site) MUST exist before the snapshot signing key is created, because then the database starts to hold publication state.
- Administration is LAN-only. The server reports nothing when the home internet is down; that needs external uptime monitoring.
- What the first production review found and changed is in [[2026-10-05-production-database-review]].
