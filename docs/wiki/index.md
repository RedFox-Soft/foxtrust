# Wiki Index

The catalog of all pages in this wiki. Each entry: a wikilink to the page and a one-line summary. The LLM reads this first when answering queries to identify candidate pages.

Keep summaries tight — one line each. The index is engineered to be cheap to read; a fat index defeats its purpose.

When this file exceeds ~300 lines or the wiki passes ~150 pages, shard into `wiki/indexes/<type>.md` and replace this file with a directory of shards. See the `scaling-playbook.md` reference in the `llm-wiki` skill for the migration procedure.

---

## Sources

- [[2026-09-24-feed-licence-review]] — licence check of ~25 IP feeds; network/hosting/Tor shippable, behavior data mostly local-only

## Entities

- [[iptoasn]] — feed: prefix → ASN, org, registration country; PDDL, shippable
- [[x4bnet-datacenter]] — feed: hosting/datacenter CIDRs; MIT (keep notice), shippable
- [[tor-exit]] — feed: Tor CollecTor exit lists with timestamps; CC0, shippable
- [[cymru-fullbogons]] — feed: unallocated/reserved space; no licence, local-only
- [[spamhaus-drop]] — feed: hijacked netblocks; revocable, redistribution unknown; shipped unnamed by decision
- [[feodo-tracker]] — feed: botnet C2; CC0 vs 2025 terms contested; shipped unnamed by decision
- [[blocklist-de]] — feed: SSH/login brute force, 48 h lists; no licence; shipped unnamed by decision
- [[iana-special-purpose]] — built-in special-purpose/bogon ranges; CC0, shippable
- [[ipverse-cloud]] — feed: BGP prefixes of the public-cloud ASNs in config/cloud/asns.csv, from ipverse/as-ip-blocks; CC0, shippable
- [[iana-address-space]] — feed: IANA IPv4/IPv6 allocation registries → unallocated/reserved bogons; CC0, shippable

## Concepts

- [[code-hosting]] — category code `hosting`, weight 0.15
- [[code-cloud]] — category code `cloud`, weight 0.1, from [[ipverse-cloud]] (config 2026-10-06.1)
- [[code-vpn]] — category code `vpn`, weight 0.25 (reserved, no stage 1 feed)
- [[code-tor-exit]] — category code `tor_exit`, weight 0.35
- [[code-bogon]] — category code `bogon`, weight 0.3
- [[code-botnet-c2]] — behavior code `botnet_c2`, weight 0.9, half-life 336 h
- [[code-hijacked-netblock]] — behavior code `hijacked_netblock`, weight 0.85, half-life 720 h
- [[code-ssh-bruteforce]] — behavior code `ssh_bruteforce`, weight 0.6, half-life 72 h
- [[code-login-bruteforce]] — behavior code `login_bruteforce`, weight 0.55, half-life 72 h

## Synthesis

- [[adr-history-and-retention]] — ADR: intervals, listing episodes, daily aggregates; retention 90 d + 365 d, artifacts 30 d
- [[adr-log-share-contributions]] — ADR: log-share split of noisy-OR risk into reasons that add up exactly
- [[adr-category-only-cap]] — ADR: cap the category part at 69 so categories alone never reach high
- [[adr-stage1-feed-selection]] — ADR: the 7 stage 1 feeds, rejected feeds, stage 2 behavior-licence risk
- [[adr-customer-facing-behavior-data]] — ADR (superseded 2026-10-05): DROP/Feodo/blocklist.de stay internal; customer behavior signals from first-party data only
- [[adr-publication-topology]] — ADR: own publication server, three containers from one image, signing key as a Docker secret, verifiers pin keys
- [[adr-snapshot-format]] — ADR: flattened customer records in MMDB, cumulative deltas with tombstones, detached Ed25519 signatures, `/v1/` layout
- [[adr-accuracy-measures]] — ADR: known-good false-positive gate (medium and high), fresh leave-one-source-out known-bad samples, early detection; no fixed labelled set
- [[adr-cloud-category]] — ADR: own public-cloud ASN list (exclusions for resolvers/CDN) × ipverse prefixes; configs enable sources; confidence 0.9
- [[adr-operator-alerts]] — ADR: Telegram operator alerts; a minute tick reconciles feed/release state into `alert_problem`; no outbox; token redacted
- [[adr-ship-behavior-feeds-unnamed]] — ADR: DROP/Feodo/blocklist.de ship to customers without their source (`ship: yes`); `ship: no` withdraws a feed
- [[adr-postgresql-storage]] — ADR: PostgreSQL with `inet`/`cidr` + `tstzrange` in GiST indexes, `Bun.sql`, no ORM
- [[adr-production-hosting]] — ADR: production on the home server `geekom`; images built on the PC; one-command deploy/rollback in the homeserver repo
- [[2026-10-05-production-database-review]] — first production review: cached-plan memory leak, `last_seen` rewrite churn, history kept, Postgres tuning, follow-ups
- [[adr-test-strategy]] — ADR: decision logic tested in memory, PostgreSQL per query path, families only where they matter, parallel test files
- [[candidate-data-sources]] — sources not yet ingested, by layer (network, anonymization, abuse, first-party); residential proxies out of scope
- [[adr-challenge-page]] — ADR: built-in challenge page on the protected host, SHA-256 proof-of-work by level, /64 passes, no-JavaScript path off by default
- [[adr-bot-verdict]] — ADR: bot verdict on the challenge page; probe + header cross-checks + optional JA4, log-odds over the address prior, observe by default, recorded labelled set
- [[tls-fingerprints-at-the-proxy]] — JA4 for /verify per proxy (nginx/Caddy modules, Envoy native, Traefik impossible, Cloudflare Enterprise only); JA4 BSD-3 but JA4+ needs a FoxIO OEM licence
- [[private-access-tokens]] — Privacy Pass for the challenge page: no public production issuer for third parties; verification feasible in Bun; deferred
- [[challenge-bot-detection]] — research for B-12: bot verdict from cost, environment, behavior, attestation (log-odds over the address prior); no captcha, no login-state probing
