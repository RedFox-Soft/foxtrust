# FoxTrust — IP Trust

An IP reputation service. For every address it answers three questions:

1. **What is this address?** Network, ASN, prefix, country, and category: hosting, VPN, Tor, mobile, residential, bogon.
2. **What has it done recently?** Brute force, spam, scanning, credential stuffing, C2.
3. **Why do we think so?** Every conclusion is backed by signals, each with its source and age.

> Status: **pre-alpha**. Stage 1 (core) is implemented: a local, explainable `lookup(ip)` over seven licence-checked feeds. There is no public API or snapshot yet.

## Quick start

```sh
bun install
docker compose up -d db
cp .env.example .env                      # DATABASE_URL, DATABASE_URL_TEST
bun run foxtrust db migrate
bun run foxtrust config activate config/scoring/2026-09-24.1.json
bun run foxtrust ingest                   # downloads the 7 feeds (licence-gated)
bun run foxtrust lookup 185.220.101.5     # add --json for the machine-readable verdict
bun run foxtrust feeds status
bun run foxtrust schedule                 # long-running: per-feed schedules + nightly retention
```

Other commands: `feeds confirm <run>`, `retention run`, `eval [--compare a.json b.json]`, `config check <file>`. `bun test` runs the acceptance and security tests (needs `DATABASE_URL_TEST`). `bun run bench` measures the success criteria.

## Principles

- **"What it is" is separate from "what it did".** Categories (facts about the network) change slowly and are not dangerous on their own: an AWS IP is hosting, not an attacker. Behavior signals decay over time.
- **A decision is a policy on top of both layers.** The score alone blocks nothing. Example: "Tor on the login page → challenge; hosting + brute force in the last 24 h → block".
- **Explainability is the core differentiator.** Every response includes `reasons[]`: signal code, source, `lastSeen`, and contribution to the final risk. The delisting process builds on this: the owner of an address sees why it was flagged and can dispute it.
- **Feed licences are checked before a feed is added.** Commercial use and redistribution are not allowed everywhere (Spamhaus, some FireHOL lists). Shipping a snapshot inside the SDK counts as redistribution.

## Model

```ts
type Signal = {
  kind: "category" | "behavior";
  code: string;            // "tor_exit", "ssh_bruteforce", "hosting"
  source: string;          // feed id: "tor-exit", "blocklist-de"
  prefix: string;          // matched prefix, CIDR
  confidence: number | null; // feed-provided, else per-source default
  firstSeen: Date;
  lastSeen: Date;
  shippable: boolean;      // false when the feed licence forbids redistribution
};                         // weight and halfLifeHours come from the scoring config, per code

type Verdict = {
  ip: string;                  // canonical form
  risk: number;                // 0..100, one decimal
  level: "low" | "medium" | "high";
  categories: string[];        // ["hosting", "tor"]
  reasons: {
    code: string; kind: "category" | "behavior"; source: string; prefix: string;
    firstSeen: string; lastSeen: string; contribution: number; shippable: boolean;
  }[];                         // contributions add up to risk
  network: { asn: number | null; org: string | null; prefix: string | null; country: string | null };
  dataVersion: string;         // data state + scoring algorithm + config, e.g. "dv42.noisy-or/1.3f9a2b1c"
  evaluatedAt: string;         // lookups accept a past evaluation time and reproduce old verdicts
  behaviorHistoryIncomplete: boolean;
};
```

The JSON Schema is in `schemas/verdict.schema.json`.

Risk is computed with noisy-OR:

```
risk = 1 − Π (1 − wᵢ · cᵢ · decayᵢ),   decayᵢ = 0.5 ^ (ageHoursᵢ / halfLifeHoursᵢ)
```

The formula is monotonic, easy to explain ("this signal contributes 40%"), and needs no ML to start. Behavior signals have half-lives measured in days; categories have long or infinite ones.

## Architecture

```
 feeds / honeypots / foxauth telemetry
            │
            ▼
   ingest worker (Bun, every N minutes)
            │
            ▼
   PostgreSQL: prefixes + categories (cidr, GiST), per-IP events, aggregates
            │
     ┌──────┴────────────┐
     ▼                   ▼
 API (Elysia)       MMDB snapshot builder (full daily, delta hourly, signed)
 GET /v1/ip/{ip}         │
 /verify                 ▼
 SEO pages          TS SDK: local lookup, auto-update, API fallback
```

- **PostgreSQL**, not MongoDB: native `inet`/`cidr` types and GiST indexes answer "which prefixes contain this IP" directly.
- **MMDB** as the snapshot format: readers exist for every popular language, so the data is usable even without our SDK.

## Data sources

| Layer | Sources |
|-------|---------|
| Network, ASN, prefixes | RIR delegated stats, RouteViews, RIPE RIS, PeeringDB |
| Cloud and hosting | Published ranges of AWS, GCP, Azure, Oracle, Cloudflare, DigitalOcean |
| Bogon | Team Cymru |
| Anonymization | Tor exit nodes, Mullvad and Proton server lists, VPN provider ASNs |
| Abuse | Spamhaus DROP, abuse.ch (Feodo, ThreatFox), blocklist.de, DShield, CINS, FireHOL |
| First-party | Honeypots (SSH/HTTP) across several providers, opt-in foxauth telemetry |

Residential proxies are out of scope for the MVP. Later they can be detected through indirect signals: many accounts from one IP, a JA4 fingerprint that does not match the claimed browser, a time zone mismatch.

## Roadmap

- [x] **1. Core.** Postgres schema, 5–7 reliable feeds, signal model, explainable scoring. Outcome: a working local `lookup(ip)`.
- [ ] **2. Distribution.** MMDB snapshot, TS SDK (Bun/Node), foxauth middleware, `/verify` for forward-auth.
- [ ] **3. Public.** `GET /v1/ip/{ip}` with a free tier, IP/ASN pages, "my IP" page, delisting process.
- [ ] **4. First-party data.** Honeypots, opt-in foxauth telemetry.
- [ ] **5. Quality.** Labelled set of known-good and known-bad addresses, false-positive rate tracked for every snapshot release.

## Stack

[Bun](https://bun.sh) · [Elysia](https://elysiajs.com) · TypeScript · PostgreSQL

## Documentation

| What | Where |
|------|-------|
| Instructions for AI agents | [AGENTS.md](AGENTS.md) |
| Knowledge base (feeds, licences, decisions) | [docs/wiki/index.md](docs/wiki/index.md), conventions in [docs/wiki/SCHEMA.md](docs/wiki/SCHEMA.md) |
| Feature specs (spec-kit) | `specs/` |
| Project principles | [.specify/memory/constitution.md](.specify/memory/constitution.md) |

## Licence

Code is licensed under [Apache-2.0](LICENSE). Third-party feed data is subject to its owners' licences.
