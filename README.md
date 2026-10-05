# FoxTrust — IP Trust

An IP reputation service. For every address it answers three questions:

1. **What is this address?** Network, ASN, prefix, country, and category: hosting, VPN, Tor, mobile, residential, bogon.
2. **What has it done recently?** Brute force, spam, scanning, credential stuffing, C2.
3. **Why do we think so?** Every conclusion is backed by signals, each with its code, age and contribution.

> Status: **pre-alpha**. Stage 1 (core) and stage 2 (distribution) are implemented: an explainable `lookup(ip)` over eight licence-checked feeds, signed MMDB snapshots of the customer verdict, and a `/verify` forward-auth service with policies. There is no public API yet.

## Quick start

```sh
bun install
docker compose up -d db
cp .env.example .env                      # DATABASE_URL, DATABASE_URL_TEST
bun run foxtrust db migrate
bun run foxtrust config activate config/scoring/2026-09-30.1.json
bun run foxtrust ingest                   # downloads the 8 feeds (licence-gated)
bun run foxtrust lookup 185.220.101.5     # add --json for the machine-readable verdict
bun run foxtrust feeds status
bun run foxtrust schedule                 # long-running: per-feed schedules + nightly retention
```

To keep ingestion running unattended, run the scheduler container:

```sh
docker compose up -d --build scheduler
docker compose ps                         # "healthy" while the scheduler heartbeat is fresh
docker compose logs -f scheduler          # one line per feed run
```

At start the container:

1. applies migrations;
2. activates `config/scoring/2026-09-30.1.json`, but only if no config is active yet;
3. runs the scheduler.

Docker restarts the container if it exits (`restart: unless-stopped`). Fetched artifacts live in the `feed-artifacts` volume. The licence pages from `docs/wiki/entities/` are copied into the image, so rebuild after editing them. Running `ingest` by hand at the same time is safe: per-feed advisory locks prevent overlapping runs.

Other commands: `feeds confirm <run>`, `retention run`, `eval [--compare a.json b.json] [--window <days>] [--sample <n>] [--contribution]`, `config check <file>`, `snapshot list|at|verify|retention run`, `policy check <file>`. `bun test` runs the acceptance and security tests (needs `DATABASE_URL_TEST`). `bun run bench` measures the success criteria.

## Snapshots and forward-auth

The scheduler also publishes the **customer verdict** as signed MMDB snapshots: a full file every day at 04:50 UTC and a cumulative delta every hour. Standard MaxMind DB readers can open them. Only shippable feeds go in (network, hosting, Tor and bogon data, plus the behavior feeds shipped by decision), and reasons carry a code, a time and a contribution, but never the source.

1. **Create the signing key** (once) and publish its public half:

   ```sh
   bun run foxtrust keys generate --out var/keys          # signing.key.pem stays secret; never commit it
   bun run foxtrust keys add var/keys/<keyId>.pub        # lists it in <publication>/v1/keys.json
   ```

   `docker-compose.yml` mounts `var/keys/signing.key.pem` (or `FOXTRUST_SIGNING_KEY_FILE`) into the scheduler as a Docker secret. Without the key the scheduler only ingests. Publishing also needs `FOXTRUST_DISPUTE_URL`, the public copy of [docs/dispute.md](docs/dispute.md).

2. **Publish and serve.** `docker compose up -d --build scheduler publication`. The `publication` service serves `/v1/` read-only on port 8081 (put your TLS proxy in front). To build right away: `docker compose exec scheduler bun run src/cli/main.ts snapshot build --full`. A build that fails validation is not published; one whose accuracy report shows a regression is held until `snapshot publish <version> --release-note "<why>"`. The accuracy report (`/v1/reports/<version>.json`) checks the known-good reference `config/accuracy/known-good.csv` (or `FOXTRUST_KNOWN_GOOD`): resolvers, root servers, mirrors and CDNs that must never be blocked. A release that newly rates more of them `medium` or `high` (by more than 0.5 percentage points) is a regression. The report also shows early detection for an earlier full release once shippable behavior data exists, and names no feed.

`foxtrust eval` measures the same reference, plus false negatives on a fresh sample of addresses that the behavior feeds reported in the last 7 days (each scored without the feed it came from) and early detection per feed; `--contribution` shows what each feed adds.

3. **Run `/verify`** next to your reverse proxy: `docker compose up -d verify` (port 8080). It needs `FOXTRUST_PUBLICATION_URL`, `FOXTRUST_TRUSTED_KEYS` and a policy file (`config/policies/example.yaml`: Tor on `/login*` → challenge, `high` → block, default allow). It answers from memory and checks the publication every 5 minutes. `GET /status` shows the data version, its age and the last error.

**Keys.** There is no public FoxTrust publication yet, so there is no FoxTrust public key to publish here. Pin the key of the publication you run: `FOXTRUST_TRUSTED_KEYS` takes the base64 value from `var/keys/<keyId>.pub`. `v1/keys.json` is informational, and `/verify` trusts only pinned keys. To verify a file without FoxTrust tools: `openssl pkeyutl -verify -pubin -inkey <keyId>.pub.pem -rawin -in f20261001.mmdb -sigfile f20261001.mmdb.sig`.

**Proxies.** `/verify?proxy=nginx|traefik|caddy`. On `challenge` it redirects to `FOXTRUST_CHALLENGE_URL` with `?return=<original URL>` (nginx: `401` plus `X-FoxTrust-Challenge-Location`). Without a challenge URL it applies `FOXTRUST_CHALLENGE_FALLBACK` (default `allow`) and logs it. Every answer carries `X-FoxTrust-Action`, `-Rule`, `-Reason` and `-Snapshot`.

```nginx
location / {
    auth_request /foxtrust-verify;
    auth_request_set $foxtrust_challenge $upstream_http_x_foxtrust_challenge_location;
    error_page 401 = @foxtrust_challenge;
    proxy_pass http://app;
}
location = /foxtrust-verify {
    internal;
    proxy_pass http://foxtrust-verify:8080/verify?proxy=nginx;
    proxy_pass_request_body off;
    proxy_set_header Content-Length "";
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header X-Original-URI $request_uri;
    proxy_set_header X-Original-Method $request_method;
}
location @foxtrust_challenge { return 302 $foxtrust_challenge; }
```

```yaml
# Traefik (dynamic configuration)
http:
  middlewares:
    foxtrust:
      forwardAuth:
        address: "http://foxtrust-verify:8080/verify?proxy=traefik"
        trustForwardHeader: true
```

```caddyfile
forward_auth foxtrust-verify:8080 {
    uri /verify?proxy=caddy
}
```

Set `FOXTRUST_TRUSTED_PROXIES` to your proxy's address range: `X-Forwarded-For` is honoured only from there.

## Principles

- **"What it is" is separate from "what it did".** Categories (facts about the network) change slowly and are not dangerous on their own: an AWS IP is hosting, not an attacker. Behavior signals decay over time.
- **A decision is a policy on top of both layers.** The score alone blocks nothing. Example: "Tor on the login page → challenge; hosting + brute force in the last 24 h → block".
- **Explainability is the core differentiator.** There are two verdict views. The **internal** verdict (operators, delisting, evaluation) gives every reason with its signal code, source, matched prefix, `lastSeen` and contribution. The **customer** verdict (snapshots, `/verify`, later the SDK and public API) is computed from shippable feeds only, and its reasons say what the address was seen doing: code, `lastSeen` and contribution, without the source. The owner of a listed address can see why and dispute it ([docs/dispute.md](docs/dispute.md)).
- **Feed licences are checked before a feed is added.** Commercial use and redistribution are not allowed everywhere (Spamhaus, some FireHOL lists). Shipping a snapshot inside the SDK counts as redistribution. A feed whose terms do not clearly allow it ships only by a recorded decision (`ship: yes` on its wiki page), is never named to customers, and can be withdrawn with `ship: no`.

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
  shippable: boolean;      // false when the feed may not reach customers (licence or `ship: no`)
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
| Bogon | IANA special-purpose and address-space registries (Team Cymru fullbogons: internal only) |
| Anonymization | Tor exit nodes, Mullvad and Proton server lists, VPN provider ASNs |
| Abuse | Spamhaus DROP, abuse.ch (Feodo, ThreatFox), blocklist.de, DShield, CINS, FireHOL |
| First-party | Honeypots (SSH/HTTP) across several providers, opt-in foxauth telemetry |

Residential proxies are out of scope for the MVP. Later they can be detected through indirect signals: many accounts from one IP, a JA4 fingerprint that does not match the claimed browser, a time zone mismatch.

## Roadmap

- [x] **1. Core.** Postgres schema, 5–7 reliable feeds, signal model, explainable scoring. Outcome: a working local `lookup(ip)`.
- [x] **2. Distribution.** Signed MMDB snapshots (daily full, hourly cumulative deltas, one-year archive, release reports), policies and `/verify` for forward-auth.
- [ ] **3. Public.** `GET /v1/ip/{ip}` with a free tier, TS SDK (Bun/Node: local lookup, auto-update, API fallback), IP/ASN pages, "my IP" page, delisting process.
- [ ] **4. First-party data.** Honeypots, opt-in foxauth telemetry, foxauth middleware.
- [ ] **5. Quality.** Known-good false-positive gate on every release, fresh known-bad samples and early detection (done, spec 003); independent known-bad labels from first-party data.

## Stack

[Bun](https://bun.sh) · [Elysia](https://elysiajs.com) · TypeScript · PostgreSQL

## Documentation

| What | Where |
|------|-------|
| Instructions for AI agents | [AGENTS.md](AGENTS.md) |
| Knowledge base (feeds, licences, decisions) | [docs/wiki/index.md](docs/wiki/index.md), conventions in [docs/wiki/SCHEMA.md](docs/wiki/SCHEMA.md) |
| Disputing a listing | [docs/dispute.md](docs/dispute.md) (published as `FOXTRUST_DISPUTE_URL`) |
| Feature specs (spec-kit) | `specs/` |
| Project principles | [.specify/memory/constitution.md](.specify/memory/constitution.md) |

## Licence

Code is licensed under [Apache-2.0](LICENSE). Third-party feed data is subject to its owners' licences.
