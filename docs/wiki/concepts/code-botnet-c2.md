---
type: concept
kind: signal
title: "Signal code botnet_c2"
tags: [scoring]
created: 2026-09-24
updated: 2026-09-24
sources: [2026-09-24-feed-licence-review]
signal_kind: behavior
half_life_hours: 336
---

# Signal code botnet_c2

Address was seen operating as a botnet command-and-control server.

| Field | Value |
|-------|-------|
| Kind | behavior |
| Weight | 0.9 |
| Half-life | 336 h (14 days) |
| Produced by | [[feodo-tracker]] |

Behavior signals decay from their last sighting as `0.5 ^ (age / half-life)`; the half-life passes the retention check of [[adr-history-and-retention]].

Values are from `config/scoring/2026-09-24.1.json`; change them only with an evaluation against the labelled set (constitution Principle VI).
