---
type: source
title: Feed licence review (2026-09-24)
tags: [data, license]
created: 2026-09-24
updated: 2026-09-24
authors: [FoxTrust planning research]
url: null
raw: docs/raw/2026-09-24-feed-licence-review.md
ingested: 2026-09-24
---

# Feed licence review (2026-09-24)

A live check of the terms of about 25 candidate IP data feeds for the stage 1 core (`specs/001-core-ip-lookup`, research R1). Each feed got one of three verdicts: SHIP (commercial use and redistribution allowed), LOCAL-ONLY, or AVOID.

## Key findings

- **Network, hosting and Tor data can be shipped cleanly:**
  - [[iptoasn]] (PDDL);
  - [[x4bnet-datacenter]] (MIT);
  - [[tor-exit]] (CollecTor, CC0).
- **Almost no behavior data can be redistributed commercially:**
  - [[spamhaus-drop]] is free to use, but attribution is required, the right is revocable, and it grants no IP licence;
  - [[feodo-tracker]] has a dataset page that says CC0, while the abuse.ch platform terms of 2025-11-04 contradict it;
  - [[blocklist-de]] has no licence at all.

  Shippable behavior data will have to come from our own honeypots or from paid licences.
- **[[cymru-fullbogons]]** is "No-Cost Access" with no redistribution grant. For snapshots, unallocated space should be computed from IANA plus the RIR stats.
- **[[iana-special-purpose]]** registries are public reference data and are built into the code.

## Rejected candidates

- **CAIDA pfx2as:** non-profit use only.
- **RIPE RIS:** non-commercial, with a revocable exception.
- **DShield:** CC BY-NC-SA, "do not resell".
- **CINS Army:** the EULA forbids distribution.
- **FireHOL level1:** inherits DShield's NC-SA terms.
- **ThreatFox:** needs an Auth-Key; commercial use is paid.
- **Dataplane.org:** non-commercial only.
- **Official cloud range files** (AWS, GCP, Azure, Cloudflare, DigitalOcean, Oracle): no licence is stated, so they are local-only.

## Follow-ups

- Ask Spamhaus for written permission to redistribute DROP in snapshots.
- Ask abuse.ch whether Feodo Tracker is still CC0 under the 2025-11-04 terms.
- Candidate shippable hosting sources: brianhama/bad-asn-list (MIT) joined with ipverse/as-ip-blocks (CC0).
