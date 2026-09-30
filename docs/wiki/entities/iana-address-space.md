---
type: entity
kind: feed
title: IANA IPv4 address space and IPv6 unicast assignments
tags: [data, license]
created: 2026-09-30
updated: 2026-09-30
sources: [2026-09-24-feed-licence-review]
url: https://www.iana.org/assignments/ipv4-address-space/ipv4-address-space.csv
license: CC0 1.0 (IANA protocol registries)
license_url: https://www.iana.org/help/licensing-terms
commercial_use: yes
redistribution: yes
attribution: no
update_interval: 1d
license_checked: 2026-09-30
---

# IANA IPv4 address space and IPv6 unicast assignments

The two IANA registries that say which top-level blocks are allocated to Regional Internet Registries. Both are CSV files:

- https://www.iana.org/assignments/ipv4-address-space/ipv4-address-space.csv: `/8` blocks with Status `ALLOCATED`, `LEGACY` or `RESERVED`.
- https://www.iana.org/assignments/ipv6-unicast-address-assignments/ipv6-unicast-address-assignments.csv: the blocks inside `2000::/3` that have been assigned.

**Licence:** IANA's licensing terms put the Protocol Registries under the Creative Commons CC0 1.0 dedication ("may be freely used by any party for any purpose"), the same as [[iana-special-purpose]].

**Used for:** the shippable `bogon` category for space that is reserved or not allocated at IANA level:

- IPv4 `/8` blocks marked `RESERVED`;
- the parts of `2000::/3` with no `ALLOCATED` entry.

This replaces [[cymru-fullbogons]] in public snapshots, because Team Cymru data may not be redistributed. RIR-level "available" space is not included: RIR delegated statistics grant no redistribution rights ([[2026-09-24-feed-licence-review]]).

Source: [[2026-09-24-feed-licence-review]].
