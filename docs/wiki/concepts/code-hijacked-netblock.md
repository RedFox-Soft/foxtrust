---
type: concept
kind: signal
title: "Signal code hijacked_netblock"
tags: [scoring]
created: 2026-09-24
updated: 2026-09-24
sources: [2026-09-24-feed-licence-review]
signal_kind: behavior
half_life_hours: 720
---

# Signal code hijacked_netblock

Address is in a netblock listed as hijacked or controlled by criminals.

| Field | Value |
|-------|-------|
| Kind | behavior |
| Weight | 0.85 |
| Half-life | 720 h (30 days) |
| Produced by | [[spamhaus-drop]] |

Behavior signals decay from their last sighting as `0.5 ^ (age / half-life)`; the half-life passes the retention check of [[adr-history-and-retention]].

Values are from `config/scoring/2026-09-24.1.json`; change them only with an evaluation against the labelled set (constitution Principle VI).
