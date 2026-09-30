---
type: entity
kind: feed
title: Spamhaus DROP / DROPv6
tags: [data, license, open-question, contested]
created: 2026-09-24
updated: 2026-09-30
sources: [2026-09-24-feed-licence-review]
url: https://www.spamhaus.org/drop/drop_v4.json
license: Spamhaus DROP terms of use (DROP Fair Use Policy)
license_url: https://www.spamhaus.org/blocklists/drop-fair-use-policy/
commercial_use: yes
redistribution: unknown
attribution: unknown
update_interval: 1h
license_checked: 2026-09-30
---

# Spamhaus DROP / DROPv6

Netblocks that are hijacked or controlled by criminals, as NDJSON (`cidr`, `sblid`, `rir`) in two files: `drop_v4.json` and `drop_v6.json`. EDROP was merged into DROP on 2024-04-10. The publisher asks: "Please DO NOT auto-fetch the DROP list more than once per hour!"

- **Licence:** the list page says DROP should be available "at no cost, regardless of size or business type". By 2026-09-30 the terms had moved to the "DROP Fair Use Policy" page.
- **Limits in the terms (re-checked 2026-09-30):**
  - the content "is protected by copyright and database right", and nothing grants a "licence of any intellectual property rights" (§3.1);
  - §3.2 forbids using the "Spamhaus" name or "any reference to the 'Spamhaus data'" in "marketing, promotional or any other commercial materials";
  - the right to use can be revoked "for any reason" (§3.3).
- **Changed since 2026-09-24:** the earlier statement "when used in a product, credit must be given to Spamhaus Project" is no longer on the site, and it conflicts with §3.2. `attribution` is therefore now `unknown`. This matters for us: verdict reasons name their source (`spamhaus-drop`), which may count as a reference to Spamhaus data in a commercial API.
- **Status:** redistribution is treated as `unknown`, so the feed is **local-only**.
- **Used for:** the `hijacked_netblock` behavior signal (half-life 30 days).

## Open question

Before stage 2 snapshots, get Spamhaus's written answers to three questions:

1. May signals derived from DROP be redistributed in snapshots and API responses?
2. May verdicts name the source?
3. If not, which commercial terms apply?

A request draft was prepared on 2026-09-30.

Source: [[2026-09-24-feed-licence-review]].
