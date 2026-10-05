---
type: entity
kind: feed
title: ipverse as-ip-blocks (public-cloud ASNs)
tags: [data, license]
created: 2026-10-05
updated: 2026-10-05
sources: []
url: https://raw.githubusercontent.com/ipverse/as-ip-blocks/master/as/16509/aggregated.json
license: CC0 1.0 Universal
license_url: https://github.com/ipverse/as-ip-blocks/blob/master/LICENSE
commercial_use: yes
redistribution: yes
attribution: no
update_interval: 1d
license_checked: 2026-10-05
---

# ipverse as-ip-blocks (public-cloud ASNs)

Daily datasets of the prefixes each autonomous system announces in BGP, IPv4 and IPv6, aggregated, one directory per AS: https://github.com/ipverse/as-ip-blocks. The repository was updated daily as of 2026-10-05.

- **Licence:** CC0 1.0 Universal (repository README and LICENSE). Commercial use and redistribution are allowed, with no attribution required.
- **What FoxTrust reads:** for each **included** ASN of `config/cloud/asns.csv`, the file `as/<asn>/aggregated.json`: the `asn` field and the `prefixes.ipv4` / `prefixes.ipv6` lists. About 14 files and 300 KB a day.
- **What it does not read:** the `metadata` block. In particular, the `category` field puts hosting, cloud and content providers in one class, so it cannot separate cloud from hosting.
- **Used for:** the `cloud` category signal ([[code-cloud]]), source id `ipverse-cloud`.
- **Which ASNs:** the project's own reviewed list, `config/cloud/asns.csv`. Which company holds an ASN is a public registry fact, and each row cites its PeeringDB record. ASNs that also carry public resolvers, NTP or CDN edges (Google 15169, Cloudflare 13335, Akamai 20940) are listed as excluded.
- **Not used:** the providers' own published range files (AWS `ip-ranges.json`, GCP `cloud.json`, Azure service tags). They state no licence, so they stay out ([[2026-09-24-feed-licence-review]]).
- **Data quality:** announced prefixes, not allocations, so a prefix a provider announces for a customer also counts. The scoring config gives the source a confidence of 0.9 for this reason.

Decision: [[adr-cloud-category]].
