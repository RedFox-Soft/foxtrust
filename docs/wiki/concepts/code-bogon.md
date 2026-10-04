---
type: concept
kind: signal
title: "Signal code bogon"
tags: [scoring]
created: 2026-09-24
updated: 2026-09-24
sources: [2026-09-24-feed-licence-review]
signal_kind: category
half_life_hours: none
---

# Signal code bogon

Address is reserved, special-purpose or unallocated and should not appear as a public source.

| Field | Value |
|-------|-------|
| Kind | category (verdict category `bogon`) |
| Weight | 0.3 |
| Half-life | none (valid while the feed lists the prefix) |
| Produced by | [[cymru-fullbogons]], [[iana-special-purpose]] |

A category is a fact about the network, not about behavior; category signals alone can never make an address `high` ([[adr-category-only-cap]]).

Values are from `config/scoring/2026-09-24.1.json`; change them only with an accuracy evaluation (`foxtrust eval --compare`, constitution Principle VI, [[adr-accuracy-measures]]).
