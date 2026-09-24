---
type: synthesis
kind: decision
title: "ADR: stage 1 feed selection"
tags: [data, license, open-question]
created: 2026-09-24
updated: 2026-09-24
sources: [2026-09-24-feed-licence-review]
status: accepted
decided: 2026-09-24
---

# ADR: stage 1 feed selection

## Context

Stage 1 needs 5–7 feeds that cover prefix→ASN/org/country, hosting, Tor, bogons and at least two behavior sources (FR-013). Every licence must be recorded before ingestion (FR-014), and data with unknown or non-commercial terms must never be shipped (Principle III). The facts come from [[2026-09-24-feed-licence-review]].

## Decision

Seven feeds, plus a built-in bogon source:

| Feed | Role | Gate status |
|------|------|-------------|
| [[iptoasn]] | network info | shippable |
| [[x4bnet-datacenter]] | `hosting` | shippable |
| [[tor-exit]] | `tor_exit` | shippable |
| [[cymru-fullbogons]] | `bogon` | local-only |
| [[spamhaus-drop]] | `hijacked_netblock` | local-only |
| [[feodo-tracker]] | `botnet_c2` | local-only |
| [[blocklist-de]] | `ssh_bruteforce`, `login_bruteforce` | local-only |

[[iana-special-purpose]] is the built-in bogon source (CC0).

**Rejected:** CAIDA pfx2as, RIPE RIS, DShield, CINS Army, FireHOL, ThreatFox, Dataplane.org, and the official cloud range files. The review has the reasons.

**Aggregated feeds:** none are ingested in stage 1, so the spec's "aggregated feed repeats an upstream feed" edge case does not apply yet.

## Consequences and open questions

- **Stage 2 risk:** almost no behavior data can be redistributed commercially. Snapshots may carry little behavior data until one of these happens:
  - Spamhaus confirms in writing that DROP may be redistributed;
  - abuse.ch confirms that Feodo Tracker is still CC0 under the 2025-11-04 terms;
  - paid licences are bought;
  - first-party honeypots (stage 4) produce data.
- **Measured accuracy:** on the fixture data, leave-one-source-out evaluation gives an FN rate of 100 %, because no known-bad address appears in two independent feeds. The FN rate means little until sources overlap.
- **Possible hosting upgrade:** brianhama/bad-asn-list (MIT) joined with ipverse/as-ip-blocks (CC0).
