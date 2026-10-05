---
type: synthesis
title: "Candidate data sources by layer"
tags: [data, open-question]
created: 2026-10-05
updated: 2026-10-05
sources: [2026-09-24-feed-licence-review]
---

# Candidate data sources by layer

Sources FoxTrust may add later, grouped by layer. This list is not a licence decision. A source gets an entity page, with its licence facts, before it is ingested (constitution Principle III). Licence status found so far is in [[2026-09-24-feed-licence-review]], and the reasons for the stage 1 selection are in [[adr-stage1-feed-selection]].

| Layer | Ingested now | Candidates |
|-------|--------------|------------|
| Network, ASN, prefixes | [[iptoasn]] | RIR delegated stats, RouteViews, RIPE RIS, PeeringDB |
| Cloud and hosting | [[x4bnet-datacenter]], [[ipverse-cloud]] | — (providers' own range files state no licence, see [[adr-cloud-category]]) |
| Bogon | [[iana-special-purpose]], [[iana-address-space]], [[cymru-fullbogons]] (internal only) | — |
| Anonymization | [[tor-exit]] | Mullvad and Proton server lists, VPN provider ASNs ([[code-vpn]] has no feed yet) |
| Abuse | [[spamhaus-drop]], [[feodo-tracker]], [[blocklist-de]] | abuse.ch ThreatFox, DShield, CINS, FireHOL (inherits its strictest upstream licence) |
| First-party | — | Honeypots (SSH/HTTP) across several providers, opt-in foxauth telemetry |

## Residential proxies

Out of scope for the MVP. They could later be detected through indirect signals: many accounts behind one IP, a JA4 fingerprint that does not match the claimed browser, a time-zone mismatch.
