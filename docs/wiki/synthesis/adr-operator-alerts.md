---
type: synthesis
kind: decision
title: "ADR: operator alerts in Telegram from reconciled problem state"
tags: [operations]
created: 2026-10-05
updated: 2026-10-05
sources: []
status: accepted
decided: 2026-10-05
---

# ADR: operator alerts in Telegram from reconciled problem state

## Context

Before spec 004, every pipeline problem ended up only in the scheduler log and in database fields. Examples: a feed run held by the shrink guard, a feed that stopped updating, a snapshot release held by the regression gate or rejected by validation, a job that threw. The container healthcheck watches the scheduler heartbeat, so it catches a dead scheduler but not stale data.

On 2026-10-04 blocklist.de served empty files for hours, and the shrink guard held every run without anyone being told. Once snapshots are published, a held release leaves customers on old data until the operator publishes it with a release note.

Problems are also resolved outside the scheduler: `foxtrust feeds confirm` and `foxtrust snapshot publish` run as separate CLI processes.

## Decision

- **Channel**: Telegram, one operator chat (the group that already receives the home server's host alerts). The scheduler calls the Bot API `sendMessage` with plain `fetch`: no dependency, plain text, link previews off, a 10 s timeout per attempt.
- **Detection by reconciliation**: a tick every minute derives feed problems (latest run held, or no success for more than 2× the schedule gap) and release problems (newest finished release of a kind held or rejected) from `feed`, `feed_run` and `snapshot_release`. It stores the differences in one table, `alert_problem`. Job errors are the only events recorded at the moment they happen, by the scheduler's job wrapper, because nothing else stores them.
- **No outbox**: each row keeps its current state and the last state told to the operator. A tick renders every difference (opened, recovered, happened-and-resolved, reminder after 24 h) into one message. Rows are marked only after Telegram accepts it. Retries, ordering, combining and restart safety follow from this.
- **Database outage**: kept as the one in-memory problem, so an outage still alerts.
- **The token is a secret**: it comes from `FOXTRUST_TELEGRAM_BOT_TOKEN` (or a file, for a Docker secret). It is redacted from every log line, error, CLI output and stored detail, and it is never written to the database. A security test checks this.
- **Optional**: without a token and a chat id, alerts are off and the scheduler behaves as before.

## Consequences

- **The operator learns of problems in minutes**: held runs, stale feeds, held or rejected releases and job errors arrive within a minute or two, with the command that resolves them, and their recovery follows.
- **Alert texts name feeds and runs**: the chat is an operator channel, not a customer-facing output (constitution Principle II).
- **Not covered**: a stopped scheduler sends nothing. That stays with the container healthcheck and an external uptime check (backlog B-06).
- **New channels**: e-mail or a generic webhook would only need another sender; the problem model is channel-independent.
- Spec: `specs/004-operator-alerts/` (kept locally).
