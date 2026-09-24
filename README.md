# FoxTrust — IP Trust

An IP reputation service. For every address it answers three questions:

1. **What is this address?** Network, ASN, prefix, country, and category: hosting, VPN, Tor, mobile, residential, bogon.
2. **What has it done recently?** Brute force, spam, scanning, credential stuffing, C2.
3. **Why do we think so?** Every conclusion is backed by signals, each with its source and age.

> Status: **pre-alpha**. No code yet; the repository holds the plan and the documentation tooling.

## Principles

- **"What it is" is separate from "what it did".** Categories (facts about the network) change slowly and are not dangerous on their own: an AWS IP is hosting, not an attacker. Behavior signals decay over time.
- **A decision is a policy on top of both layers.** The score alone blocks nothing. Example: "Tor on the login page → challenge; hosting + brute force in the last 24 h → block".
- **Explainability is the core differentiator.** Every response includes `reasons[]`: signal code, source, `lastSeen`, and contribution to the final risk. The delisting process builds on this: the owner of an address sees why it was flagged and can dispute it.
- **Feed licences are checked before a feed is added.** Commercial use and redistribution are not allowed everywhere (Spamhaus, some FireHOL lists). Shipping a snapshot inside the SDK counts as redistribution.

## Model

```ts
type Signal = {
  kind: "category" | "behavior";
  code: string;            // "tor_exit", "ssh_bruteforce", "aws"
  source: string;          // "tor-project", "honeypot-fra1"
  weight: number;          // 0..1
  confidence: number;      // 0..1
  firstSeen: Date;
  lastSeen: Date;
  halfLifeHours?: number;  // absent = does not decay
};

type Verdict = {
  ip: string;
  risk: number;            // 0..100
  level: "low" | "medium" | "high";
  categories: string[];    // ["hosting", "vpn"]
  reasons: { code: string; source: string; lastSeen: string; contribution: number }[];
  network: { asn: number; org: string; prefix: string; country: string };
  snapshotVersion: string;
};
```

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

- [ ] **1. Core.** Postgres schema, 5–7 reliable feeds, signal model, explainable scoring. Outcome: a working local `lookup(ip)`.
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
