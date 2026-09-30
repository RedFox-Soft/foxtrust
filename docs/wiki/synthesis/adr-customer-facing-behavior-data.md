---
type: synthesis
kind: decision
title: "ADR: customer-facing behavior signals come from first-party data only"
tags: [data, license, distribution, first-party]
created: 2026-09-30
updated: 2026-09-30
sources: [2026-09-24-feed-licence-review]
status: accepted
decided: 2026-09-30
---

# ADR: customer-facing behavior signals come from first-party data only

## Context

All three stage 1 behavior feeds are local-only. Their terms were checked on 2026-09-24 and re-checked on 2026-09-30 (`docs/raw/2026-09-30-licence-recheck.md`).

- **[[spamhaus-drop]]** is free to use, but its terms grant no IP licence (the list is protected by database right), ban any reference to Spamhaus data in commercial materials, and can be revoked at any time.
- **[[feodo-tracker]]** has a dataset page that says CC0, while the abuse.ch terms require a paid Spamhaus subscription for commercial use and forbid derivative works.
- **[[blocklist-de]]** has no licence at all.

The data does not overlap in practice. On the fixture data, no known-bad address appears in two feeds, so a behavior verdict usually rests on one of these sources alone.

We considered two options: ask Spamhaus and abuse.ch for written permission, or rely on the argument that a verdict is our own derived output.

## Decision

- **No permission requests** are sent to Spamhaus or abuse.ch for now.
- **The three feeds stay local-only.** DROP, Feodo Tracker and blocklist.de are used only internally: development, tests, accuracy evaluation, and protecting our own infrastructure. Their signals stay `shippable: false`.
- **What customers get.** Customer-facing outputs (API responses, MMDB snapshots, SDK) contain:
  - category data from shippable sources: [[iptoasn]], [[x4bnet-datacenter]], [[tor-exit]], [[iana-special-purpose]];
  - behavior signals only from first-party data (our own honeypots, roadmap stage 4) or from a future feed whose licence allows commercial redistribution.
- **Local-only data never leaks through a derived verdict.** Customer-facing risk, level and reasons are computed from shippable signals only. A local-only signal must not change what a customer sees, even if the source is never named.

## Consequences

- **Stage 2 snapshots and the stage 3 API** carry network, hosting, Tor and bogon information, but no behavior data until first-party sensors exist. Stage 4 (honeypots) is what makes the behavior layer useful for customers, so it may be worth moving earlier.
- **Scoring needs two views.** The stage 2 spec must define them:
  - the full internal verdict (all signals, with sources, for operators, delisting and evaluation);
  - the customer verdict (shippable signals only).
- **Changing this decision is possible later.** If Spamhaus or abuse.ch terms change, or a paid licence is bought, this ADR can be superseded. The feed pages keep the facts needed to decide.
- **Related:** the stage 1 feed choice is in [[adr-stage1-feed-selection]].
