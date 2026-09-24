---
type: entity
kind: feed
title: blocklist.de
tags: [data, license]
created: 2026-09-24
updated: 2026-09-24
sources: [2026-09-24-feed-licence-review]
url: https://lists.blocklist.de/lists/ssh.txt
license: none stated ("to be used at your own risk")
license_url: https://www.blocklist.de/en/terms.html
commercial_use: unknown
redistribution: unknown
attribution: unknown
update_interval: 30m
license_checked: 2026-09-24
---

# blocklist.de

Lists of addresses that attacked blocklist.de's reporters in the last 48 hours. The lists are updated every 30 minutes and carry no timestamps. We use two of them, both under https://lists.blocklist.de/lists/: `ssh.txt` and `bruteforcelogin.txt`.

- **Licence:** none. The site says "to be used at your own risk". The terms mention only that downloading "bei zu großem Volumen" (German for "at too large a volume") may be charged. The feed is **local-only**.
- **Used for:** the `ssh_bruteforce` (from `ssh.txt`) and `login_bruteforce` (from `bruteforcelogin.txt`) behavior signals, both with a half-life of 72 hours.

Source: [[2026-09-24-feed-licence-review]].
