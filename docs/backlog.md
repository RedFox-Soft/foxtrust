# Backlog

Ordered work for FoxTrust after stages 1 and 2. The roadmap in `README.md` says *what* each stage
delivers; this file says *in which order* and *why*. Pick the top open item. Feature items become
spec-kit specs (`specs/NNN-name/`); chores and ops items do not need a spec.

Last reviewed: 2026-10-06.

## Where the project stands

- **Built:** ingestion of 8 licence-checked feeds, explainable internal lookup, signed MMDB
  snapshots of the customer verdict, `/verify` forward-auth, accuracy measures (specs 001–003).
- **Running:** ingestion only, on the home server. No signing key yet, so nothing is published.
- **Decided 2026-10-05:** behavior feeds (Spamhaus DROP, Feodo Tracker, blocklist.de) go to
  customers without their source ([ADR](wiki/synthesis/adr-ship-behavior-feeds-unnamed.md),
  constitution v5.0.0). Done in B-00.
- **Decided 2026-10-06:** the challenge page tells humans from bots without a captcha and never
  probes logins to other services ([research](wiki/synthesis/challenge-bot-detection.md)).

## Direction

1. **Go live** (Now). With behavior signals in the customer verdict (B-00, done), the snapshot
   carries what was missing: what the address did. A published, signed snapshot that
   real traffic uses is the cheapest way to find what else is missing, and it starts the archive
   that early detection and regressions are measured against.
2. **Public surface** (Next). API, SDK, challenge page, IP pages and self-service delisting:
   stage 3 of the roadmap.
3. **Own behavior data** (Later). Honeypots make the product independent of third-party feeds
   whose terms can change, and give known-bad labels that no public feed produced.

Sizes: **S** ≤ 1 day, **M** ≤ 1 week, **L** a spec of several weeks.

## Now: go live

| ID | Item | Kind | Size | Done when |
|----|------|------|------|-----------|
| B-01 | **Database backups** before the signing key exists (server config lives outside this repo) | ops | S | A restore of last night's dump into a scratch database succeeds |
| B-02 | **Signing key and publication** on `foxtrust.dev`: `keys generate`, `publication` service behind the tunnel, `FOXTRUST_DISPUTE_URL` set | ops | S | `https://…/v1/manifest.json` is public and `snapshot verify` passes on a downloaded full file |
| B-03 | **Public dispute page and mailbox**: serve `docs/dispute.md` as HTML; `disputes@foxtrust.dev` delivers to you | ops | S | A test email arrives; the manifest links to the live page |
| B-04 | **Dogfood `/verify`** in front of one of your own services (Traefik `forwardAuth`), policy in log-only mode first | ops | S | A week of `X-FoxTrust-Action` headers reviewed; no false blocks of your own traffic |
| B-06 | **External uptime check** of the publication and of manifest age (stale > 26 h) | ops | S | Stopping the scheduler raises an alert the next day |

## Next: public surface (stage 3)

| ID | Item | Kind | Size | Done when |
|----|------|------|------|-----------|
| B-10 | **Spec 010: public API** `GET /v1/ip/{ip}` (customer verdict from the published snapshot), an account and API-key service (no CLI; managed through B-16 and B-15), free-tier rate limits, usage counts without queried addresses (Principle IV) | spec | L | A free key gets verdicts; over-limit requests get `429` |
| B-11 | **Spec: TS SDK** for Bun and Node: local MMDB lookup, signed auto-update, API fallback; reuses the `/verify` loader and decision engine | spec | L | `npm i` → `lookup(ip)` works offline and updates hourly |
| B-12c | **Spec 007: bot verdict** (observe mode by default; after one step-up pass unless the operator chooses block). *Built 2026-10-06 ([ADR](wiki/synthesis/adr-bot-verdict.md)); SC-001 and SC-002 pass on desktop Chrome/Edge/Opera/Firefox, Android Chrome and Tor Browser ("Standard" and "Safer"); open: Safari/iOS samples, phone timing.* Environment probe (automation markers, cross-layer consistency), optional `X-JA4` from trusted proxies (JA4 only, not JA4+), log-odds score with the address risk as prior, versioned weights config, `env.*` reason codes in the operator log only, policy pass / step-up / block; labelled set of recorded payloads from real browsers and Playwright, Puppeteer, puppeteer-stealth, patchright, Camoufox | spec | L | On the labelled set, stock headless Playwright and Puppeteer never get a token on the first attempt; real browsers pass without step-up at the rate the spec sets |
| B-13 | **IP / ASN pages and "my IP" page**: public, indexable, customer verdict only | spec | M | `foxtrust.dev/ip/1.1.1.1` shows reasons without sources |
| B-14 | **Self-service delisting**: prove control (rDNS or WHOIS contact), file a dispute, see its state; replaces the manual email flow in `docs/dispute.md`. More important now that behavior listings ship | spec | L | A dispute filed on the site removes the reason in the next hourly delta |
| B-15 | **Spec: site and accounts** on `foxtrust.dev`: landing, API docs, sign-in through foxauth (OIDC), a personal page to create and revoke own keys and see usage; server-rendered HTML from Elysia with a strict CSP, no front-end framework. Uses the account and key service of B-10; limits self-service keys per account. Hosts B-13 and B-14 later | spec | L | A new visitor signs in, creates a free key and gets a verdict with it, without the operator |
| B-16 | **Spec: operator admin panel**: accounts and keys (limits, revoke), usage, feed and run health, snapshot releases and gate holds, alerts; later the dispute queue (B-14). A separate service, not published: reachable only through the tunnel behind Cloudflare Access, plus an operator role in foxauth | spec | L | The operator revokes a key and releases a held snapshot from the panel, without the CLI |

## Next: more categories (can run in parallel with stage 3)

| ID | Item | Kind | Size | Done when |
|----|------|------|------|-----------|
| B-20 | **Licence check of VPN sources** (Mullvad and Proton server lists, VPN provider ASN lists); record each in `docs/wiki/entities/` | research | S | Each candidate has a verdict and a wiki page |
| B-21 | **`vpn` category** from the sources that pass B-20 (the code is reserved, weight 0.25) | feature | M | `lookup` of a Mullvad exit shows `vpn`; it appears in the snapshot |
| B-23 | **RIR delegated stats** licence check for unallocated space (more precise public bogons than IANA level) | research | S | Verdict recorded; feed added if it passes |

## Later: own behavior data (stage 4a)

| ID | Item | Kind | Size | Done when |
|----|------|------|------|-----------|
| B-30 | **Spec: honeypot sensors.** Low-interaction SSH and HTTP sensors (Bun, one container), signed event upload to an ingestion endpoint, events limited to IP, event type, timestamp and sensor id (Principle IV), raw retention period, new feed of kind `behavior`; codes `ssh_bruteforce`, `http_scan`, `login_bruteforce` | spec | L | A customer snapshot carries a behavior reason from a sensor; `eval` shows early detection for the first-party feed |
| B-31 | **Sensor hosting**: 3 small VPS at different providers and regions (the home IP is residential and geo-filtered, so it is a poor sensor); record the choice as an ADR | ops | S | Three sensors report events for 7 days |
| B-32 | **First-party feed page and signal codes** in the wiki (`docs/wiki/entities/foxtrust-honeypots.md`, `code-http-scan`), scoring config with weights and half-lives, tuned with `eval --compare` | docs | S | Config activated after a comparison that shows no known-good regression |
| B-33 | **Independent known-bad labels** from honeypot data (roadmap stage 5): addresses seen by sensors and by no feed are a fair test of the public feeds, and vice versa | feature | M | `eval` reports false negatives against honeypot labels |
| B-34 | **Challenge outcomes as a first-party feed**: repeated failed challenges per address become behavior code `challenge_fail` (needs B-12c; Principle IV fields only) | spec | M | An address that keeps failing the challenge carries `challenge_fail` in the next snapshot |

## Later: foxauth and beyond

| ID | Item | Kind | Size | Done when |
|----|------|------|------|-----------|
| B-40 | **foxauth middleware** on the shared decision engine (stage 4b) | spec | M | foxauth applies a FoxTrust policy at login |
| B-41 | **Opt-in foxauth telemetry** as a first-party behavior feed (IP, event type, timestamp, integration id only; off by default) | spec | L | Failed-login bursts from one IP become a `login_bruteforce` signal |
| B-42 | **Residential proxy signals** (many accounts per IP, JA4 mismatch, time zone mismatch); needs B-41 data first | research | L | A written approach with measured precision on foxauth data |
| B-43 | **Publication on object storage or a CDN** when traffic outgrows the home server; only the base URL changes | ops | M | Clients read `/v1/` from the CDN; the home server only builds |

## Done

- Specs 001 (core lookup), 002 (snapshot distribution), 003 (accuracy measures).
- B-00 (2026-10-05): behavior feeds ship without their source; `ship: yes|no` on feed pages,
  constitution v5.0.0.
- B-07 (2026-10-05): CI on every push (typecheck, ESLint with typescript-eslint, tests).
- B-05 (2026-10-05): Telegram operator alerts (spec 004); deploy on the server pending.
- B-12d (2026-10-06): behavior evidence (spec 009): a press-and-hold step for every challenged
  visitor, eleven `behavior.*` codes; scripted holds (straight, ghost-cursor, stealth, CDP, key
  script) get no pass, the owner's mouse, phone and keyboard holds pass; touchpad samples pending
  ([ADR](wiki/synthesis/adr-behavior-evidence.md)).
- B-12e (2026-10-06): returning-device token (spec 008): zero-cost challenge after an address change,
  bot verdict still runs, cap 20 addresses per 24 h, revocation on block or failed step-up, hashed
  per-instance state ([ADR](wiki/synthesis/adr-returning-device.md)).
- B-12f (2026-10-06): research. JA4 can reach `/verify` from nginx/Caddy modules and Envoy, not
  Traefik; Cloudflare only on Enterprise; JA4+ needs a FoxIO OEM licence
  ([page](wiki/synthesis/tls-fingerprints-at-the-proxy.md)). No PAT issuer usable by a third party
  in production ([page](wiki/synthesis/private-access-tokens.md)).
- B-12b (2026-10-06): constitution v5.1.0, Principle IV covers client-side signals of the challenge
  page and snippets (in memory only, codes and score logged, no fingerprint identifiers, no probing).
- B-12a (2026-10-06): built-in challenge page in `/verify` (spec 006): SHA-256 proof-of-work by
  verdict level, `/32` / `/64` passes, no-JavaScript path off by default
  ([ADR](wiki/synthesis/adr-challenge-page.md)); timing on a phone and in Tor Browser "Safer" pending.
- B-22 (2026-10-05): `cloud` category from public-cloud ASNs (config/cloud/asns.csv) and ipverse
  prefixes (spec 005); activate config 2026-10-06.1 on the server after `eval --compare`.
