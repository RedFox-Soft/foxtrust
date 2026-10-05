---
type: concept
kind: signal
title: "Signal code cloud"
tags: [scoring]
created: 2026-09-24
updated: 2026-10-05
sources: []
signal_kind: category
half_life_hours: none
---

# Signal code cloud

Address is announced by a public-cloud ASN of the reviewed list `config/cloud/asns.csv`.

| Field | Value |
|-------|-------|
| Kind | category (verdict category `cloud`) |
| Weight | 0.1 |
| Half-life | none (valid while the feed lists the prefix) |
| Produced by | [[ipverse-cloud]] (source confidence 0.9 from config 2026-10-06.1) |

A category is a fact about the network, not about behavior; category signals alone can never make an address `high` ([[adr-category-only-cap]]). An address in both a cloud and a hosting prefix carries both categories.

Why and how the ASN list and the feed were chosen: [[adr-cloud-category]].

Values are from `config/scoring/2026-10-06.1.json`; change them only with an accuracy evaluation (`foxtrust eval --compare`, constitution Principle VI, [[adr-accuracy-measures]]).
