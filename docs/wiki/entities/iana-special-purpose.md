---
type: entity
kind: feed
title: IANA special-purpose address registries
tags: [data, license]
created: 2026-09-24
updated: 2026-09-24
sources: [2026-09-24-feed-licence-review]
url: https://www.iana.org/assignments/iana-ipv4-special-registry/
license: CC0 1.0 (IANA protocol registries)
license_url: https://www.iana.org/help/licensing-terms
commercial_use: yes
redistribution: yes
attribution: no
update_interval: 30d
license_checked: 2026-09-24
---

# IANA special-purpose address registries

The IANA IPv4 and IPv6 Special-Purpose Address Registries, at https://www.iana.org/assignments/iana-ipv4-special-registry/ and https://www.iana.org/assignments/iana-ipv6-special-registry/.

- **Licence:** IANA's licensing terms say the Protocol Registries "may be freely used by any party for any purpose", and that any rights in them "are subject to the Creative Commons CC0 1.0 dedication".
- **How it is used:** **built in, not fetched.** Both CSVs were downloaded on 2026-09-24 and transcribed into `src/ip/special-purpose.ts`, with `REGISTRY_SNAPSHOT_DATE = 2026-09-24`.
- **Which entries count:** blocks that are not "Globally Reachable", plus the multicast blocks (RFC 5771, RFC 4291). They give the `bogon` category from source `iana-special-purpose` (FR-023).
- **Exceptions:** globally reachable entries such as 192.0.0.9/32 (PCP anycast) or 2001::/32 (Teredo) are not bogons, even inside a bogon block.
- **Keeping it current:** re-check the registries when IANA publishes changes. The registry changes rarely; the most recent entry is 2025-04 (RFC 9780).

Source: [[2026-09-24-feed-licence-review]].
