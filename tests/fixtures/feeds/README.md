# Recorded feed fixtures

Real feed files, recorded on **2026-09-24** and trimmed to keep the repository small. Tests read only these files, never the live feeds. Licences are recorded in `docs/wiki/entities/<feed>.md`.

| Fixture | Source URL | Trimming |
|---------|------------|----------|
| `iptoasn/ip2asn-combined.tsv.gz` | https://iptoasn.com/data/ip2asn-combined.tsv.gz | first 1,000 IPv4 rows + first 1,000 IPv6 rows |
| `iptoasn/ip2asn-combined.v2.tsv.gz` | derived | same rows; the first row's ASN changed to 64496 (US2-6) |
| `x4bnet-datacenter/ipv4.txt`, `ipv6.txt` | https://raw.githubusercontent.com/X4BNet/lists_vpn/main/output/datacenter/ | first 500 lines each |
| `x4bnet-datacenter/ipv4.v2.txt` | derived | `ipv4.txt` without lines 11–20 (US2-6) |
| `tor-exit/exit-list.txt` | https://collector.torproject.org/recent/exit-lists/2026-09-24-15-10-11 | first 400 records |
| `tor-exit/index.html` | https://collector.torproject.org/recent/exit-lists/ | as recorded |
| `tor-exit/shrunk.txt` | derived | first 50 records: 37 unique addresses, under 50 % of the 115 in `exit-list.txt` (US2-5) |
| `tor-exit/malformed.txt` | derived | 50 records, then a record cut off mid-line (US2-4) |
| `cymru-fullbogons/fullbogons-ipv4.txt`, `fullbogons-ipv6.txt` | https://team-cymru.org/Services/Bogons/ | header + first 300 prefixes each |
| `spamhaus-drop/drop_v4.json` | https://www.spamhaus.org/drop/drop_v4.json | first 200 records + the metadata line |
| `spamhaus-drop/drop_v6.json` | https://www.spamhaus.org/drop/drop_v6.json | as recorded |
| `feodo-tracker/ipblocklist.json` | https://feodotracker.abuse.ch/downloads/ipblocklist.json | as recorded (the live list was not empty) |
| `blocklist-de/ssh.txt`, `bruteforcelogin.txt` | https://lists.blocklist.de/lists/ | first 1,000 IPv4 lines + all IPv6 lines |
| `blocklist-de/ssh.v2.txt` | derived | `ssh.txt` without its first 100 lines (US2-7) |
| `_security/gzip-bomb.gz` | generated | `1.2.3.4\n` repeated to 1.1 GB, gzip -9 (≈ 1.6 MB); `SEC:` tests |

## Cloud ranges (SC-003 measurement data only)

`tests/fixtures/cloud/` holds the unique prefixes of https://ip-ranges.amazonaws.com/ip-ranges.json and https://www.gstatic.com/ipranges/cloud.json, recorded on 2026-09-24. There is no stated licence, so they are local-only and used only to sample addresses for the SC-003 measurement, never as a feed.
