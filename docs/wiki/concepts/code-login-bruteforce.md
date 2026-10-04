---
type: concept
kind: signal
title: "Signal code login_bruteforce"
tags: [scoring]
created: 2026-09-24
updated: 2026-09-24
sources: [2026-09-24-feed-licence-review]
signal_kind: behavior
half_life_hours: 72
---

# Signal code login_bruteforce

Address was seen brute-forcing web or application logins.

| Field | Value |
|-------|-------|
| Kind | behavior |
| Weight | 0.55 |
| Half-life | 72 h (3 days) |
| Produced by | [[blocklist-de]] |

Behavior signals decay from their last sighting as `0.5 ^ (age / half-life)`; the half-life passes the retention check of [[adr-history-and-retention]].

Values are from `config/scoring/2026-09-24.1.json`; change them only with an accuracy evaluation (`foxtrust eval --compare`, constitution Principle VI, [[adr-accuracy-measures]]).
