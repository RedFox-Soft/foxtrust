---
type: concept
kind: signal
title: "Signal code hosting"
tags: [scoring]
created: 2026-09-24
updated: 2026-09-24
sources: [2026-09-24-feed-licence-review]
signal_kind: category
half_life_hours: none
---

# Signal code hosting

Address is in a hosting or datacenter range.

| Field | Value |
|-------|-------|
| Kind | category (verdict category `hosting`) |
| Weight | 0.15 |
| Half-life | none (valid while the feed lists the prefix) |
| Produced by | [[x4bnet-datacenter]] |

A category is a fact about the network, not about behavior; category signals alone can never make an address `high` ([[adr-category-only-cap]]).

Values are from `config/scoring/2026-09-24.1.json`; change them only with an accuracy evaluation (`foxtrust eval --compare`, constitution Principle VI, [[adr-accuracy-measures]]).
