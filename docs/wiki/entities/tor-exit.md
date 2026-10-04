---
type: entity
kind: feed
title: Tor exit lists (CollecTor)
tags: [data, license]
created: 2026-09-24
updated: 2026-10-04
sources: [2026-09-24-feed-licence-review]
url: https://collector.torproject.org/recent/exit-lists/
license: CC0 (Tor Metrics data)
license_url: https://metrics.torproject.org/collector.html
commercial_use: yes
redistribution: yes
attribution: no
update_interval: 1h
license_checked: 2026-09-24
---

# Tor exit lists (CollecTor)

Hourly exit-list files in `tordnsel` format (`ExitNode`, `Published`, `LastStatus`, `ExitAddress ip timestamp`). The Tor Project says the data is "freely available under a CC0 no copyright declaration".

- **Used for:** the `tor_exit` category signal (verdict category `tor`).
- **Ingestion:** reads the newest file in the directory listing.
- **Why not the bulk list:** `check.torproject.org/torbulkexitlist` has no licence and no timestamps.
- **Alternative:** Onionoo carries first and last seen for each relay, under the same CC0 terms.
- **Mirror:** where the ISP blocks `torproject.org`, `FOXTRUST_TOR_EXIT_URL` points ingestion at a
  read-only Cloudflare Worker (`deploy/tor-mirror/worker.js`) that serves the same
  `/recent/exit-lists/` paths byte for byte. The data and its CC0 terms are unchanged; the mirror
  adds no transformation. Third-party lists (SecOps-Institute, dan.me.uk, FireHOL `tor_exits`) were
  rejected: no timestamps, extra intermediaries, and dan.me.uk states no licence.

Source: [[2026-09-24-feed-licence-review]].
