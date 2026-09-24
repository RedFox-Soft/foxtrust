---
type: entity
kind: feed
title: iptoasn.com IP-to-ASN database
tags: [data, license]
created: 2026-09-24
updated: 2026-09-24
sources: [2026-09-24-feed-licence-review]
url: https://iptoasn.com/data/ip2asn-combined.tsv.gz
license: PDDL v1.0 (public domain)
license_url: https://iptoasn.com/
commercial_use: yes
redistribution: yes
attribution: no
update_interval: 1h
license_checked: 2026-09-24
---

# iptoasn.com IP-to-ASN database

Maps IPv4 and IPv6 ranges to ASN, AS description and registration country. The file is a TSV (`range_start range_end AS_number country_code AS_description`). The site says it is "Licensed under Public Domain (PDDL v1.0)" and "Updated hourly".

- **Used for:** network info in verdicts (ASN, organisation, prefix, country), per FR-022. Ingested as `network_interval` rows after splitting each range into minimal CIDRs.
- **ASN 0** ("Not routed") becomes `asn: null`, and country `None` becomes null.
- **Country** is the RIR registration country, not geolocation.
- **Data quality:** no timestamps and no confidence values.

Source: [[2026-09-24-feed-licence-review]].
