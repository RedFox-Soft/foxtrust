---
type: synthesis
kind: decision
title: "ADR: the cloud category from our own ASN list and ipverse prefixes"
tags: [data, license, scoring]
created: 2026-10-05
updated: 2026-10-05
sources: [2026-09-24-feed-licence-review]
status: accepted
decided: 2026-10-05
---

# ADR: the cloud category from our own ASN list and ipverse prefixes

## Context

The `cloud` code ([[code-cloud]]) was reserved since stage 1, but nothing filled it. The providers' own range files (AWS `ip-ranges.json`, GCP `cloud.json`, Azure service tags) state no licence and are local-only ([[2026-09-24-feed-licence-review]]).

The candidate sources checked on 2026-10-05 cannot separate cloud from hosting:

- brianhama/bad-asn-list (MIT, last updated 2026-04) mixes cloud, managed hosting and colocation.
- The `category` field of ipverse as-metadata puts hosting, cloud and content providers in one class.

Customers using `/verify` want rules such as "public cloud on the login page → challenge", without catching every small host or VPN that [[x4bnet-datacenter]] lists as `hosting`.

## Decision

- **Own list of ASNs**: `config/cloud/asns.csv` lists public-cloud ASNs. A provider counts when it sells self-service IaaS: virtual machines ordered through an API, billed by use, in several regions. Each row has its PeeringDB record as the public source. Which company holds an ASN is a public registry fact, so the list is our own licence-clean data.
  - The initial list includes 15 ASNs: AWS ×3, Google Cloud, Azure, Oracle, Alibaba, Tencent, IBM, DigitalOcean, Linode, Vultr, Hetzner, OVHcloud and Scaleway.
  - **Exclusions**: ASNs that also carry public resolvers, NTP or CDN edges are listed as excluded: Google 15169 (8.8.8.8, time.google.com), Cloudflare 13335 (1.1.1.1) and Akamai 20940. The initial list was checked against the known-good reference. Only Vultr overlaps it (two NextDNS resolver addresses), and those stay `low`: cloud + hosting is about 20 points, while `medium` starts at 30.
- **Prefixes from ipverse**: [[ipverse-cloud]] reads the BGP-announced prefixes of the included ASNs daily from ipverse/as-ip-blocks (CC0). It uses one small per-ASN JSON file each, about 300 KB a day. A broken list fails the run and keeps the stored data.
- **Configs enable sources**: a scoring config scores only the sources in its `sourceConfidence`. Signals of other sources are left out of risk, reasons and categories, and the scheduler and `config check` report the feed as "not enabled" instead of refusing to start. This narrows a start-up check of spec 001, so that a new feed can be ingested and evaluated (`eval --compare`) before the config that enables it is activated (constitution Principle VI).
- **Confidence 0.9**: config 2026-10-06.1 gives `ipverse-cloud` a confidence of 0.9. Announcement by the provider's own ASN is strong evidence, but a prefix can be announced for a customer. The `cloud` weight stays 0.1.

## Consequences

- **What changes for customers**: snapshots, `/verify` and later the API show `cloud` for addresses in the listed ASNs, and policies can match it. Most cloud addresses also stay `hosting`, because X4BNet lists them too.
- **Maintenance**: list changes are reviewed like scoring changes (`eval --compare`, known-good report). An ASN that changes hands is removed with a dated reason.
- **The relaxed rule cuts both ways**: a typo that drops a feed from a config now disables that feed quietly instead of stopping the scheduler. The notice in the scheduler log and in `config check` is the safeguard.
- **Widening `hosting`** with bad-asn-list remains a separate, measured option (backlog B-22, variant B).
- Spec: `specs/005-cloud-category/` (kept locally).
