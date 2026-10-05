---
type: synthesis
kind: decision
title: "ADR: accuracy measures: known-good false-positive gate, fresh known-bad samples, early detection"
tags: [scoring, distribution, data]
created: 2026-10-04
updated: 2026-10-05
sources: []
status: accepted
decided: 2026-10-04
---

# ADR: accuracy measures: known-good false-positive gate, fresh known-bad samples, early detection

## Context

Constitution Principle VI asked for a fixed labelled set of known-good and known-bad addresses and for false-positive and false-negative rates in every release report. In practice:

- The 142 known-bad rows were taken on 2026-09-24 from three ingested behavior feeds (Spamhaus DROP, blocklist.de, Feodo Tracker). Behavior is short-lived, so the list went stale, and it never refreshed.
- `foxtrust eval` already scored each labelled address without its own feed (leave-one-source-out), so it was not circular.
- The release report reads the customer view, and all three behavior feeds are local-only ([[adr-customer-facing-behavior-data]]). The false-negative rate there stayed near 100 % whatever a release contained, so it could not detect a regression.
- The public report listed `spamhaus-drop` among its label sources. The DROP terms (§3.2) forbid references to Spamhaus data in commercial materials ([[spamhaus-drop]]).

## Decision

Constitution v4.0.0 redefines Principle VI, and spec 003 implements it.

- **Known-good reference** in `config/accuracy/known-good.csv`: 168 never-block addresses (resolvers, root and TLD servers, NTP, mirrors, CDNs) with public sources. It is release-gate configuration, versioned and reviewed in git. Each report records its sha256.
- **Release gate.** Release report v2 gates on false positives on the reference only. A rise of more than 0.5 pp at `medium` or at `high` holds the release. The `medium` gate matters today: the customer view cannot reach `high` without shippable behavior data ([[adr-category-only-cap]]), but `medium` already drives `challenge` policies. False-negative rates are dropped from the report, and the report names no feed.
- **Fresh known-bad samples** in `foxtrust eval`: per behavior feed, up to 100 prefixes whose listing overlaps the 7 days before the evaluation time (by `recorded_at`), ordered by `md5(data version | feed | prefix)` so the sample is reproducible. Each prefix is scored without the feed it came from.
- **Early detection**: the share of addresses first recorded by a behavior feed in the 7 days after a moment that the verdict at that moment already rated `medium` or `high`. `eval` reports it internally, per feed. Release reports show it for the latest full release whose window is over, on its customer view and over **shippable** behavior sightings only, because every behavior feed has `redistribution: unknown` and Principle III keeps such data out of public outputs, aggregates included. It never gates a release.
- **Feed contribution** (`eval --contribution`): per feed, how many sampled active entries keep `medium` or `high` without it.

## Options considered

- **Keep the fixed set and refresh it by hand**: still stale between refreshes, and still meaningless in the customer view.
- **Store labels in the database**: loses review history, and a report could no longer be reproduced from one commit.
- **Resolve known-good hostnames at release time**: makes the gate depend on DNS at release time, and reports could not be reproduced.
- **Gate on early detection**: the measure lags and depends on feed volume, so it would block releases for reasons unrelated to the release.
- **Third-party known-bad lists as an independent check**: would need new licence records. Kept for later, together with first-party labels.

## Consequences

- The public early-detection figure reads "not available" until a shippable behavior source exists. Since 2026-10-05 the three behavior feeds are shippable ([[adr-ship-behavior-feeds-unnamed]]), so the figure is reported once an earlier full release has passed its window.
- Known-bad evaluation still uses the ingested feeds, but each address is scored without its own feed and the sample stays fresh. Independent labels from first-party traffic are the next step.
- `FOXTRUST_RELEASE_LABELS`, `data/labelled/` and `eval --labels` are gone; `FOXTRUST_KNOWN_GOOD` and `eval --known-good` replace them.

Code: `src/eval/` (`known-good.ts`, `sample.ts`, `early-detection.ts`, `contribution.ts`, `evaluate.ts`), `src/snapshot/report.ts`.
