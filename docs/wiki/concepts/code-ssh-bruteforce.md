---
type: concept
kind: signal
title: "Signal code ssh_bruteforce"
tags: [scoring]
created: 2026-09-24
updated: 2026-09-24
sources: [2026-09-24-feed-licence-review]
signal_kind: behavior
half_life_hours: 72
---

# Signal code ssh_bruteforce

Address was seen brute-forcing SSH logins.

| Field | Value |
|-------|-------|
| Kind | behavior |
| Weight | 0.6 |
| Half-life | 72 h (3 days) |
| Produced by | [[blocklist-de]] |

Behavior signals decay from their last sighting as `0.5 ^ (age / half-life)`; the half-life passes the retention check of [[adr-history-and-retention]].

Values are from `config/scoring/2026-09-24.1.json`; change them only with an evaluation against the labelled set (constitution Principle VI).
