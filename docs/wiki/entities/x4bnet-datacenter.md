---
type: entity
kind: feed
title: X4BNet datacenter list (lists_vpn)
tags: [data, license]
created: 2026-09-24
updated: 2026-09-30
sources: [2026-09-24-feed-licence-review]
url: https://raw.githubusercontent.com/X4BNet/lists_vpn/main/output/datacenter/ipv4.txt
license: MIT
license_url: https://github.com/X4BNet/lists_vpn#license
commercial_use: yes
redistribution: yes
attribution: yes
update_interval: 1d
license_checked: 2026-09-30
notice: "lists_vpn datacenter list, MIT License, Copyright (c) 2024 X4B (Mathew Heard)"
---

# X4BNet datacenter list (lists_vpn)

CIDR lists of hosting and datacenter ranges, rebuilt by CI from ASN lists. There are two files: `output/datacenter/ipv4.txt` and `output/datacenter/ipv6.txt`, both in https://github.com/X4BNet/lists_vpn.

- **Licence:** MIT ("to use, modify, and distribute"). The licence text is in the repository README (there is no LICENSE file) and covers "the scripts, automation, and the list itself". Snapshots keep the copyright notice "Copyright (c) 2024 X4B (Mathew Heard)" (re-checked 2026-09-30).
- **Used for:** the `hosting` category signal.
- **Data quality:** no timestamps.
- **Possible replacement:** if coverage on the labelled set is too low, brianhama/bad-asn-list (MIT) joined with ipverse/as-ip-blocks (CC0) is the next candidate.

Source: [[2026-09-24-feed-licence-review]].
