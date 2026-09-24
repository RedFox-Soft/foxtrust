# FoxTrust feed licence review (checked 2026-09-24)

Research report produced during planning of `specs/001-core-ip-lookup` (research R1). Each feed's
own pages were read live on 2026-09-24. Quotes are as returned by the fetch tool. Verdicts:
**SHIP** (commercial + redistribution OK), **LOCAL-ONLY**, **AVOID**. AGENTS.md: a feed with no
licence is not shipped in snapshots.

## Network / ASN / country

- **iptoasn.com**: https://iptoasn.com/data/ip2asn-combined.tsv.gz (also `-v4`/`-v6` and
  `ip2country-*` variants). TSV `range_start range_end AS_number country_code AS_description`,
  IPv4 and IPv6. The site says "Licensed under Public Domain (PDDL v1.0)" and "Updated hourly".
  Commercial use and redistribution are allowed under PDDL; no attribution is required. No
  timestamps or confidence. The country is the RIR registration country, not geolocation.
  **SHIP.**
- **CAIDA pfx2as**: https://publicdata.caida.org/datasets/routing, TSV prefix/len/AS, IPv4 and
  IPv6, daily. The CAIDA AUA (https://www.caida.org/about/legal/aua/) grants use "for the purpose
  of non-profit research, non-profit education, commercial internal testing and evaluation";
  other commercial use goes through the "UC San Diego Office of Innovation & Commercialization".
  Citation and publication reporting are required. **AVOID** in the product (LOCAL-ONLY for
  evaluation). Alternative: the RouteViews raw RIBs are "licensed under a Creative Commons
  Attribution 4.0 International License" (https://www.routeviews.org/routeviews/faq/), so a
  prefix-to-AS table built from them is **SHIP with attribution**.
- **RIPE RIS / RIPEstat**: raw-data T&C (https://www.ripe.net/analyse/raw-data-sets/terms-conditions/)
  Art. 3.1: "use of the Data for any commercial purposes, for example selling the Data or services
  based on the Data, is not allowed"; Art. 3.3 forbids re-distributing without written
  permission. A separate RIS page grants "a revocable permission" for paid services, with the RIPE
  NCC logo, a link to ripe.net/ris and boilerplate text required; "permission can be revoked at
  any time". **LOCAL-ONLY.**
- **RIR delegated-extended stats** (for example
  https://ftp.ripe.net/pub/stats/ripencc/delegated-ripencc-extended-latest; same naming at ARIN,
  APNIC, LACNIC and AFRINIC): pipe-separated, IPv4/IPv6/ASN, daily. APNIC README: "freely available
  for download and use on the condition that APNIC will not be held responsible". Per
  https://github.com/openasn/openasn/pull/11, AFRINIC and LACNIC grant the same "download and
  use", ARIN states no terms, RIPE NCC reserves all rights, and none grants redistribution.
  Records carry an allocation date. **LOCAL-ONLY** (curation input only).

## Cloud ranges

No licence is named on any of these; they are facts published so people can filter traffic, so
the risk is low but the licence is technically unknown. **LOCAL-ONLY** unless confirmed in
writing, or unless the same coverage comes from ASN-level hosting lists.

- **AWS** https://ip-ranges.amazonaws.com/ip-ranges.json: JSON `syncToken`, `createDate`,
  `prefixes[]`, `ipv6_prefixes[]` (region, service, network_border_group). Also an RFC 8805
  `geo-ip-feed.csv` and SNS update notifications.
- **Google Cloud** https://www.gstatic.com/ipranges/cloud.json (and goog.json), IPv4 and IPv6;
  cloud.json has the region.
- **Azure Service Tags** https://www.microsoft.com/en-us/download/details.aspx?id=56519,
  `ServiceTags_Public_YYYYMMDD.json`, "updated weekly".
- **Cloudflare** https://www.cloudflare.com/ips-v4/ and /ips-v6/, plain text.
- **DigitalOcean** https://www.digitalocean.com/geo/google.csv, `prefix,country,region,city,postal`.
- **Oracle** https://www.oracle.com/iaas/tools/public_ip_ranges.json, IPv4 only; poll "as
  frequently as every 24 hours", "at least weekly".

## Hosting / datacenter

- **X4BNet/lists_vpn** https://github.com/X4BNet/lists_vpn: `output/datacenter/ipv4.txt` and
  `ipv6.txt`, rebuilt by CI from ASN lists. MIT ("to use, modify, and distribute"); keep the
  copyright notice. No timestamps. **SHIP.**
- **brianhama/bad-asn-list** https://github.com/brianhama/bad-asn-list: `bad-asn-list.csv`
  (ASN, Entity), "ASNs known to belong to cloud, managed hosting, and colo facilities". MIT.
  **SHIP.**
- **ipverse/as-ip-blocks** https://github.com/ipverse/as-ip-blocks: prefixes per ASN, IPv4 and
  IPv6, daily, CC0 1.0. Joined with the ASN lists above it gives shippable hosting coverage.
  **SHIP.**
- **client9/ipcat**: MIT, but archived since 2023-02-02 and stale. **AVOID** for freshness.

## Tor

- **Bulk exit list** https://check.torproject.org/torbulkexitlist: plain IPv4, no header, no
  timestamps, no licence stated.
- **CollecTor exit lists** https://collector.torproject.org/recent/exit-lists/: `tordnsel` format
  (`ExitNode`, `Published`, `LastStatus`, `ExitAddress ip timestamp`). "freely available under a
  CC0 no copyright declaration" (https://metrics.torproject.org/collector.html). **SHIP.**
- **Onionoo** https://metrics.torproject.org/onionoo.html: relays with first_seen and last_seen,
  same CC0 statement. **SHIP.** Prefer CollecTor or Onionoo over the bulk list because they carry
  timestamps.

## Bogons

- **Team Cymru fullbogons** https://team-cymru.org/Services/Bogons/fullbogons-ipv4.txt and
  `fullbogons-ipv6.txt`: "Updated every four hours"; "do not fetch more often than the listed
  update interval". The only terms are "No-Cost Access" and "Operated for the community, not as a
  product" (https://www.team-cymru.com/bogon-networks). No licence, no redistribution grant.
  **LOCAL-ONLY.** For snapshots, unallocated space can be computed from the IANA registries plus
  the RIR delegated stats (clearance still pending).

## Abuse / behavior

- **abuse.ch Feodo Tracker** https://feodotracker.abuse.ch/downloads/ipblocklist.csv and `.json`:
  `first_seen`, `dst_ip`, `port`, `status`, `last_online`, `malware`; IPv4. "generated every 5
  minutes"; fetch "at least every 15 minutes". The dataset page says it "can be used for both,
  commercial and non-commercial purpose without any limitations (CC0)". The platform terms of
  4 Nov 2025 (https://abuse.ch/terms-of-use/) say commercial use "may require a paid subscription,
  which will be managed by Spamhaus" (§4) and forbid "derivative works … without the express
  consent" (§7). The FAQ says datasets are "currently empty" after takedowns. **SHIP only with
  written confirmation that CC0 still applies; LOCAL-ONLY until then.**
- **abuse.ch ThreatFox** https://threatfox.abuse.ch/export/: JSON/CSV with confidence_level and
  first_seen; "you need to obtain an Auth-Key first"; regenerated every 5 minutes; IOCs expire after
  6 months. The 2025 terms limit free use to "not-for-profit purposes"; commercial use through a
  paid Spamhaus subscription. **AVOID** without a Spamhaus contract.
- **Spamhaus DROP / DROPv6** https://www.spamhaus.org/drop/drop_v4.json and `drop_v6.json` (also
  `asndrop.json`): NDJSON `cidr`, `sblid`, `rir`. EDROP was merged into DROP on 2024-04-10.
  "Please DO NOT auto-fetch the DROP list more than once per hour!" The list page says it is free
  "regardless of size or business type" and "when used in a product, credit must be given to
  Spamhaus Project, and the date and © text should remain"
  (https://www.spamhaus.org/blocklists/do-not-route-or-peer/). The terms
  (https://www.spamhaus.org/drop/terms/) add that nothing grants "licence of any intellectual
  property rights", that the right to use can be revoked, and that the Spamhaus name must not
  appear in commercial materials. **SHIP-conditional** (attribution, revocable; confirm with
  Spamhaus).
- **DShield / SANS ISC** https://www.dshield.org/api/sources/attacks/1000?json (`ip`, `count`,
  `attacks`, `firstseen`, `lastseen`): "CC BY-NC-SA 4.0"; "ok to use this data for commercial
  purposes, for example to protect your own company's network. But again: do not resell". Back off
  5 minutes after a 429. **LOCAL-ONLY** (a paid API or SDK would be resale).
- **blocklist.de** https://lists.blocklist.de/lists/all.txt (plus `ssh.txt`, `mail.txt`, …): IPs
  from the last 48 hours, updated every 30 minutes, no timestamps. "to be used at your own risk";
  the terms only mention that downloading "bei zu großem Volumen" (at too large a volume) may be
  charged (https://www.blocklist.de/en/terms.html). No licence. **LOCAL-ONLY.**
- **CINS Army** http://cinsscore.com/list/ci-badguys.txt: plain IPv4, no timestamps. The EULA
  (https://cinsarmy.com/wp-content/uploads/2017/10/EULA_2017.pdf) says "This is not free software"
  and forbids distributing "with other products (commercial or otherwise) without prior written
  permission". **AVOID.**
- **FireHOL level1** https://raw.githubusercontent.com/firehol/blocklist-ipsets/master/firehol_level1.netset:
  merges "dshield feodo fullbogons spamhaus_drop"; no licence of its own, so it inherits DShield's
  NC-SA terms. **AVOID**; pull upstream feeds directly.
- **Dataplane.org**: headers say "free for non-commercial use ONLY … Redistribution … expressly
  prohibited". **AVOID.**

## Recommended set

1. Prefix → ASN / organisation / registration country: iptoasn (PDDL), SHIP. Later, our own
   prefix-to-AS table from RouteViews RIBs (CC BY 4.0).
2. Cloud and hosting: X4BNet datacenter list + bad-asn-list (MIT) joined with ipverse (CC0),
   SHIP. Official cloud JSON files are LOCAL-ONLY until providers confirm.
3. Tor exits: CollecTor exit lists or Onionoo (CC0), SHIP.
4. Bogons: Team Cymru fullbogons, LOCAL-ONLY; compute unallocated space ourselves for snapshots.
5. Behavior #1: Spamhaus DROP / DROPv6, SHIP-conditional (credit + date/© line; at most hourly).
6. Behavior #2: Feodo Tracker, SHIP-conditional on written CC0 confirmation (nearly empty now).
7. Behavior, internal only: DShield and blocklist.de, LOCAL-ONLY.

There is almost no behavior data that can be redistributed commercially; shippable behavior data
must come from our own sensors/honeypots or paid licences.

## Special-purpose ranges (added the same day)

The IANA IPv4 and IPv6 Special-Purpose Address Registries
(https://www.iana.org/assignments/iana-ipv4-special-registry/ and
https://www.iana.org/assignments/iana-ipv6-special-registry/) were downloaded as CSV on
2026-09-24 and transcribed into `src/ip/special-purpose.ts`, including the "Globally Reachable"
column. IANA's licensing terms (https://www.iana.org/help/licensing-terms) say the Protocol
Registries "may be freely used by any party for any purpose" and that any rights in them "are
subject to the Creative Commons CC0 1.0 dedication". **SHIP.**
