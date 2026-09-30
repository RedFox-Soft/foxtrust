---
type: entity
kind: feed
title: abuse.ch Feodo Tracker
tags: [data, license, contested, open-question]
created: 2026-09-24
updated: 2026-09-30
sources: [2026-09-24-feed-licence-review]
url: https://feodotracker.abuse.ch/downloads/ipblocklist.json
license: dataset page says CC0; platform terms of 2025-11-04 restrict commercial use
license_url: https://abuse.ch/terms-of-use/
commercial_use: unknown
redistribution: unknown
attribution: unknown
update_interval: 5m
license_checked: 2026-09-24
---

# abuse.ch Feodo Tracker

Botnet command-and-control servers, IPv4. Entries carry `first_seen`, `dst_ip`, `port`, `status`, `last_online` and `malware`. The list is "generated every 5 minutes", and the publisher asks users to fetch it "at least every 15 minutes".

- **Used for:** the `botnet_c2` behavior signal (half-life 14 days), with feed-provided times from `last_online`.
- **Current state:** the FAQ says the datasets are "currently empty" after takedowns.

## Contested licence

- **Dataset page:** it "can be used for both, commercial and non-commercial purpose without any limitations (CC0)".
- **Platform terms of 2025-11-04:** commercial use "may require a paid subscription, which will be managed by Spamhaus" (§4), and derivative works are not allowed "without the express consent" (§7).

Until abuse.ch confirms CC0 in writing, the feed is **local-only**.

Re-checked on 2026-09-30:

- The terms name Spamhaus Technology Limited as "the primary licensee of the abuse.ch datasets".
- Questions go to https://www.spamhaus.com/abuse-ch/#contact-us, because abuse.ch/contact/ returns 404. The confirmation request therefore goes to Spamhaus; a draft was prepared on the same day.

Source: [[2026-09-24-feed-licence-review]].
