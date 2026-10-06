# FoxTrust — IP Trust

An IP reputation service. For every address it answers three questions:

1. **What is this address?** Network, ASN, prefix, country, and category: hosting, VPN, Tor, mobile, residential, bogon.
2. **What has it done recently?** Brute force, spam, scanning, credential stuffing, C2.
3. **Why do we think so?** Every conclusion is backed by signals, each with its code, age and contribution.

> Status: **pre-alpha**. Stage 1 (core) and stage 2 (distribution) are implemented: an explainable `lookup(ip)` over nine licence-checked feeds, signed MMDB snapshots of the customer verdict, and a `/verify` forward-auth service with policies. There is no public API yet.

## Quick start

```sh
bun install
docker compose up -d db
cp .env.example .env                      # DATABASE_URL, DATABASE_URL_TEST
bun run foxtrust db migrate
bun run foxtrust config activate config/scoring/2026-10-06.1.json
bun run foxtrust ingest                   # downloads the 9 feeds (licence-gated)
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
2. activates `config/scoring/2026-10-06.1.json`, but only if no config is active yet (a running system switches with `config activate` after `eval --compare`);
3. runs the scheduler.

Docker restarts the container if it exits (`restart: unless-stopped`). Fetched artifacts live in the `feed-artifacts` volume. The licence pages from `docs/wiki/entities/` are copied into the image, so rebuild after editing them. Running `ingest` by hand at the same time is safe: per-feed advisory locks prevent overlapping runs.

Other commands: `feeds confirm <run>`, `retention run`, `eval [--compare a.json b.json] [--window <days>] [--sample <n>] [--contribution]`, `config check <file>`, `snapshot list|at|verify|retention run`, `policy check <file>`, `alerts test|list` (see [Alerts](#alerts)). `bun test` runs the acceptance and security tests (needs `DATABASE_URL_TEST`). `bun run bench` measures the success criteria.

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
    proxy_set_header X-Forwarded-Host $http_host;
    proxy_set_header X-Forwarded-Proto $scheme;
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

**Challenge page.** `/verify` has its own challenge page, without a captcha. Set `FOXTRUST_CHALLENGE_URL=/.foxtrust/challenge` (a path, not a URL) and `FOXTRUST_CHALLENGE_SECRET` (≥ 32 characters, e.g. `openssl rand -base64 48`). A challenged visitor is sent to that path on the same host. The browser solves a small proof-of-work in the background, which takes about a second, and gets a pass cookie: 30 minutes, for its exact IPv4 address or its IPv6 `/64`. Riskier addresses get a harder proof-of-work. Route the path on each protected host to `verify` **without** forward-auth; your proxy's address must be in `FOXTRUST_TRUSTED_PROXIES`.

```nginx
location ^~ /.foxtrust/challenge {
    proxy_pass http://foxtrust-verify:8080;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

```yaml
# Traefik: a router with higher priority and without the foxtrust middleware
http:
  routers:
    foxtrust-challenge:
      rule: "Host(`app.example`) && PathPrefix(`/.foxtrust/challenge`)"
      service: foxtrust-verify
      priority: 1000
  services:
    foxtrust-verify:
      loadBalancer:
        servers: [{ url: "http://foxtrust-verify:8080" }]
```

```caddyfile
# Caddy runs forward_auth before handle, so forward_auth goes inside the fallback handle.
handle /.foxtrust/challenge* {
    reverse_proxy foxtrust-verify:8080
}
handle {
    forward_auth foxtrust-verify:8080 {
        uri /verify?proxy=caddy
    }
    reverse_proxy app:3000
}
```

The following settings are optional:

- `FOXTRUST_CHALLENGE_DIFFICULTY`: proof-of-work bits per level, default `none=14,low=14,medium=16,high=18`.
- `FOXTRUST_CHALLENGE_TTL_SECONDS`: default `120`.
- `FOXTRUST_PASS_TTL_MINUTES`: default `30`.
- `FOXTRUST_CHALLENGE_NOJS=on`: lets visitors without JavaScript pass by waiting `FOXTRUST_CHALLENGE_NOJS_WAIT_SECONDS` (default `10`). It is off by default, because bots can take that path too.

`/status` shows the challenge settings. Each pass and each refused answer is logged in one line. Limits:

- **What the proof-of-work does.** It puts a price on every pass. It does not detect bots.
- **Replays.** Repeated answers are caught per `verify` instance.
- **Plain HTTP.** On a plain-HTTP site, the proxy must send `X-Forwarded-Proto: http`, or the `Secure` pass cookie is dropped.

Design and limits: [ADR challenge page](docs/wiki/synthesis/adr-challenge-page.md).

**Bot verdict.** Before solving, the challenge page checks the browser. It looks for automation markers (the webdriver flag, a headless browser name, driver globals) and for consistency between the user agent, client hints, the rendering engine, graphics, the time zone and the screen. `/verify` cross-checks these with the request's own headers and, when your proxy sends one, a JA4 TLS fingerprint. It turns the evidence into a bot score with reason codes. The visitor never sees the score or the codes.

- **Modes.** `FOXTRUST_BOT_MODE=observe` is the default: everyone who solves the proof-of-work passes, and the log shows the score and `would=<action>`. Watch your traffic first, then set `enforce`.
- **Actions in `enforce`:**
  - a score from `FOXTRUST_BOT_STEPUP` (0.5) gets one harder proof-of-work;
  - a score from `FOXTRUST_BOT_BLOCK` (0.9) gets a `403` page with your dispute link;
  - after the step-up, `FOXTRUST_BOT_AFTER_STEPUP` (`pass` by default, or `block`) decides.
- **JA4.** Optional. `/verify` reads `X-JA4` only from `FOXTRUST_TRUSTED_PROXIES`, and only JA4 itself, never other JA4+ methods. nginx (with a module), Caddy (`xcaddy` module) and Envoy can supply it; Traefik cannot ([details](docs/wiki/synthesis/tls-fingerprints-at-the-proxy.md)).
- **Weights.** They live in `config/bot/<version>.json`, or `FOXTRUST_BOT_WEIGHTS`. `foxtrust bot eval` measures them on the labelled set in `tests/fixtures/bot-samples/`. `foxtrust bot record --label <name>` records a sample from your own browser on a development port. It is not part of `verify serve`, so visitors are never recorded.
- **Logging.** Only the outcome, address, score and reason codes are logged; probe values are dropped after the decision.

Design: [ADR bot verdict](docs/wiki/synthesis/adr-bot-verdict.md).

**Returning-device token.** A browser that passed cleanly also gets a `foxtrust_device` cookie: host-only, random, 30 days (`FOXTRUST_DEVICE_TTL_DAYS`). When the same browser is challenged again from another address (a new Tor circuit, a mobile network, travel), the page skips the proof-of-work. The bot verdict still runs. Limits:

- **Cap.** One token gets passes for at most `FOXTRUST_DEVICE_CAP` (20) addresses per 24 hours; an IPv6 `/64` counts as one address.
- **Revocation.** The token is revoked when its browser is blocked or fails a step-up.
- **State.** Revocations and caps are kept in `FOXTRUST_DEVICE_STATE` (compose: volume `verify-state`). The file holds keyed hashes, no addresses, and is per `verify` instance.

`FOXTRUST_DEVICE=off` turns it off. Design: [ADR returning device](docs/wiki/synthesis/adr-returning-device.md).

## Alerts

The scheduler can tell the operator in Telegram when something needs attention, so problems don't sit unnoticed in logs:

- a feed run held by the shrink guard (with the `feeds confirm <run>` command to run);
- a feed with no successful run for more than twice its schedule interval (2 h for hourly feeds, 48 h for daily ones), whatever the cause;
- a snapshot release held by the regression gate (with the `snapshot publish <version> --release-note` command) or rejected by validation;
- a scheduled job that failed with an error, including the database being unreachable.

A message goes out when a problem opens or closes, plus one reminder a day while it stays open. How problems are detected and delivered: [ADR operator alerts](docs/wiki/synthesis/adr-operator-alerts.md).

Set `FOXTRUST_TELEGRAM_BOT_TOKEN` (or `FOXTRUST_TELEGRAM_BOT_TOKEN_FILE`) and `FOXTRUST_TELEGRAM_CHAT_ID` in `.env`; `docker-compose.yml` passes them to the scheduler. Without them alerts are off and the scheduler logs `alerts: disabled`. The token never appears in logs, messages or the database. `bun run foxtrust alerts test` sends a test message; `alerts list` shows open problems and those closed in the last 24 hours. The chat is an operator channel: messages name feeds, runs and versions.

## Principles

- **"What it is" is separate from "what it did".** Categories (facts about the network) change slowly and are not dangerous on their own: an AWS IP is hosting, not an attacker. Behavior signals decay over time.
- **A decision is a policy on top of both layers.** The score alone blocks nothing. Example: "Tor on the login page → challenge; hosting + brute force in the last 24 h → block".
- **Explainability is the core differentiator.** There are two verdict views. The **internal** verdict (operators, delisting, evaluation) gives every reason with its signal code, source, matched prefix, `lastSeen` and contribution. The **customer** verdict (snapshots, `/verify`, later the SDK and public API) is computed from shippable feeds only, and its reasons say what the address was seen doing: code, `lastSeen` and contribution, without the source. The owner of a listed address can see why and dispute it ([docs/dispute.md](docs/dispute.md)).
- **Feed licences are checked before a feed is added.** Commercial use and redistribution are not allowed everywhere (Spamhaus, some FireHOL lists). Shipping a snapshot inside the SDK counts as redistribution. A feed whose terms do not clearly allow it ships only by a recorded decision (`ship: yes` on its wiki page), is never named to customers, and can be withdrawn with `ship: no`.

## Model

A **signal** is one feed's statement about a prefix: kind (category or behavior), code, source, prefix, confidence, `firstSeen`, `lastSeen` and whether it may reach customers. A **verdict** gives risk (0–100), level, categories, reasons whose contributions add up to the risk, network info, and the data version it was computed from. Lookups accept a past evaluation time and reproduce old verdicts. The format is defined in [schemas/verdict.schema.json](schemas/verdict.schema.json) (types: `src/model/types.ts`).

A scoring config scores only the sources listed in its `sourceConfidence`. A feed the active config leaves out is still ingested, but adds nothing to verdicts. `config check` and the scheduler report it as "not enabled", so a new feed can be evaluated with `eval --compare` before the config that enables it is activated.

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

Why these choices: [PostgreSQL](docs/wiki/synthesis/adr-postgresql-storage.md), [MMDB snapshots](docs/wiki/synthesis/adr-snapshot-format.md).

## Data sources

The ingested feeds and their licences are listed in the [wiki index](docs/wiki/index.md) (Entities). Sources that may come later, by layer, are in [candidate data sources](docs/wiki/synthesis/candidate-data-sources.md).

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
| Production (home server, deploy, reviews) | [ADR production hosting](docs/wiki/synthesis/adr-production-hosting.md) |
| Disputing a listing | [docs/dispute.md](docs/dispute.md) (published as `FOXTRUST_DISPUTE_URL`) |
| Feature specs (spec-kit) | `specs/` |
| Project principles | [.specify/memory/constitution.md](.specify/memory/constitution.md) |

## Licence

Code is licensed under [Apache-2.0](LICENSE). Third-party feed data is subject to its owners' licences.
