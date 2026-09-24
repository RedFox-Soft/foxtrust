---
type: entity
kind: feed
title: Spamhaus DROP / DROPv6
tags: [data, license, open-question]
created: 2026-09-24
updated: 2026-09-24
sources: [2026-09-24-feed-licence-review]
url: https://www.spamhaus.org/drop/drop_v4.json
license: Spamhaus DROP terms of use
license_url: https://www.spamhaus.org/drop/terms/
commercial_use: yes
redistribution: unknown
attribution: yes
update_interval: 1h
license_checked: 2026-09-24
---

# Spamhaus DROP / DROPv6

Netblocks that are hijacked or controlled by criminals, as NDJSON (`cidr`, `sblid`, `rir`) in two files: `drop_v4.json` and `drop_v6.json`. EDROP was merged into DROP on 2024-04-10. The publisher asks: "Please DO NOT auto-fetch the DROP list more than once per hour!"

- **Licence:** free "regardless of size or business type". "When used in a product, credit must be given to Spamhaus Project, and the date and © text should remain."
- **Limits in the terms:**
  - they grant no "licence of any intellectual property rights";
  - the right to use can be revoked;
  - the Spamhaus name must not appear in commercial materials.
- **Status:** redistribution is treated as `unknown`, so the feed is **local-only**.
- **Used for:** the `hijacked_netblock` behavior signal (half-life 30 days).

## Open question

Before stage 2 snapshots, get Spamhaus's written confirmation that DROP may be redistributed inside them.

Source: [[2026-09-24-feed-licence-review]].
