---
type: entity
kind: feed
title: Team Cymru fullbogons
tags: [data, license, open-question]
created: 2026-09-24
updated: 2026-09-24
sources: [2026-09-24-feed-licence-review]
url: https://team-cymru.org/Services/Bogons/fullbogons-ipv4.txt
license: none stated ("No-Cost Access")
license_url: https://www.team-cymru.com/bogon-networks
commercial_use: unknown
redistribution: no
attribution: unknown
update_interval: 4h
license_checked: 2026-09-24
---

# Team Cymru fullbogons

Unallocated and reserved IPv4 and IPv6 space, in two files: `fullbogons-ipv4.txt` and `fullbogons-ipv6.txt`. They are "Updated every four hours", with the instruction "do not fetch more often than the listed update interval".

- **Licence:** none stated. The terms say only "No-Cost Access" and "Operated for the community, not as a product". There is no redistribution grant, so the feed is **local-only**.
- **Used for:** the `bogon` category signal. Special-purpose ranges are also built in, without any feed ([[iana-special-purpose]]).

## Open question

Stage 2 snapshots cannot contain this data. Unallocated space should instead be computed from the IANA registries plus the RIR delegated stats; that computation still needs its own licence clearance.

Source: [[2026-09-24-feed-licence-review]].
