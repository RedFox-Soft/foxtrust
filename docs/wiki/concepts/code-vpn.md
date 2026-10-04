---
type: concept
kind: signal
title: "Signal code vpn"
tags: [scoring]
created: 2026-09-24
updated: 2026-09-24
sources: []
signal_kind: category
half_life_hours: none
---

# Signal code vpn

Address belongs to a commercial VPN provider (no feed in stage 1).

| Field | Value |
|-------|-------|
| Kind | category (verdict category `vpn`) |
| Weight | 0.25 |
| Half-life | none (valid while the feed lists the prefix) |
| Produced by | no feed in stage 1 (reserved code) |

A category is a fact about the network, not about behavior; category signals alone can never make an address `high` ([[adr-category-only-cap]]).

Values are from `config/scoring/2026-09-24.1.json`; change them only with an accuracy evaluation (`foxtrust eval --compare`, constitution Principle VI, [[adr-accuracy-measures]]).
