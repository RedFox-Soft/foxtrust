---
type: synthesis
kind: decision
title: "ADR: built-in challenge page with proof-of-work"
tags: [scoring, distribution]
created: 2026-10-06
updated: 2026-10-06
sources: []
status: accepted
decided: 2026-10-06
---

# ADR: built-in challenge page with proof-of-work

Decision for backlog item B-12a (spec 006). Before it, `/verify` could only send `challenge` decisions to an external page or fall back to `allow`. The wider research, and what later items add, is in [[challenge-bot-detection]].

## Decision

| Topic | Choice | Why |
|-------|--------|-----|
| Where the page lives | `verify` serves it on a path of each protected host (`FOXTRUST_CHALLENGE_URL=/.foxtrust/challenge`); the operator's proxy routes that path to `verify` without forward-auth | Only a response from the protected host can set the pass cookie there; no callback, no token in a URL; one `verify` serves any number of hosts |
| Redirect target | `<X-Forwarded-Proto>://<X-Forwarded-Host><path>?return=…`; relative only when the proxy names no host; the nginx auth location sets both headers | Found through real proxies: Traefik resolves a relative `Location` against the forward-auth address, nginx against its own listener (losing a mapped port or an outer TLS scheme) |
| Loop protection | `/verify` lets through exactly the page's five routes (with an optional query), not a prefix | A prefix match could be turned into a policy bypass through dot segments or encodings |
| Challenge | Stateless HMAC-signed `{kind, address, bits, nonce, exp, nbf}`; the MAC uses the domain `foxtrust-challenge/1` | Nothing is stored per visit; the domain keeps challenges and pass tokens, made with the same secret, from standing in for each other |
| Proof-of-work | One-block SHA-256 of `nonce ‖ counter` with `d` leading zero bits, solved in a Web Worker by a pure TypeScript SHA-256 | WebCrypto is unavailable on plain-HTTP sites and has per-call overhead; a single block keeps the client fast; tests use the same solver |
| Difficulty | Bits per customer-verdict level: `none=14, low=14, medium=16, high=18`, configurable, never fewer for a higher level | Reputation already known for the address becomes cost |
| Pass | v2 token bound to the `/32` (IPv4) or `/64` (IPv6), 30 minutes, `HttpOnly`, `SameSite=Lax`, `Secure` unless the proxy says plain HTTP; v1 tokens stay valid | IPv6 privacy addresses rotate inside a `/64` and carriers give one `/64` per device; IPv4 has no such structure |
| Single use | In-memory cache of accepted nonces per instance, 100 000 entries; at the cap the oldest is evicted, it never refuses | Refusing at the cap was a denial of service: one address could fill it with cheap answers. A per-address quota would lock out Tor exits. Replaying an evicted answer only gives its own address a pass it already holds |
| No JavaScript | A signed wait challenge (`nbf`) submitted by `<meta refresh>`; **off by default** (`FOXTRUST_CHALLENGE_NOJS=on`) | Tor Browser at "Safest" needs it, but a bot can choose it too and pay only with waiting time, so the operator decides |
| Privacy | Logs hold outcome, address, kind, bits and refusal reason; nothing else about the client is read or stored | Constitution Principle IV; client signals come only with B-12c after an amendment |

## Measurements

From `tests/perf/challenge.bench.ts` in Bun on a desktop PC (2026-10-06):

| Level | Bits | Solve p50 | Solve p95 |
|-------|------|-----------|-----------|
| low | 14 | 12 ms | 46 ms |
| medium | 16 | 40 ms | 182 ms |
| high | 18 | 157 ms | 460 ms |

- Solver rate ≈ 1.1 M hashes/s. One answer check costs 22 µs at p99.
- `/verify` p99 is 0.34 ms with a v2 pass cookie and 0.28 ms without one.
- A Chromium walk-through on a local `verify` passed end to end: page, scripts, worker, answer, `303`, cookie. It made no request to another origin.
- The same walk-through through Caddy 2, nginx 1.27 and Traefik 3 in containers, with the README routes and `verify serve`, took 0.3–0.5 s from `/login` back to `/login` with the pass. It also surfaced the redirect-target issue above.

**Still to measure** (spec 006 SC-001): a mid-range Android phone in Chrome, and Tor Browser at "Standard" and "Safer". "Safer" turns off the JavaScript JIT, which may make the solver 10–50× slower. If the 95th percentile at `medium` exceeds 3 s there, the defaults go down.

## Limits

- The proof-of-work is cost, not bot detection. Native SHA-256 solves 16 bits in milliseconds. What it buys:
  - every pass costs one solved challenge per address and per 30 minutes;
  - a client must run a script or reimplement the protocol;
  - the place where B-12c (environment checks) and B-12d (behavior) add evidence.
- Replay protection is per instance, and a restart forgets it, within the 2-minute challenge lifetime.
- When the proxy routes the challenge path to the application by mistake, those exact paths reach the application unchecked; the application normally answers `404`.
- `/32` versus `/64` binding treats the families differently on purpose: they differ in how addresses are assigned. Both families are fully supported (constitution, Technology and Data Constraints).

## Alternatives rejected

- **A page on `foxtrust.dev` with a callback on each host**: two hops and a token in a URL.
- **A separate challenge service**: a second container with the same secret, address rules and snapshot.
- **Memory-hard functions** (scrypt, Argon2): they need WebAssembly or slow pure JavaScript, and Tor Browser at "Safer" disables both WebAssembly and the JIT.
- **Server-side challenge store**: memory per visitor, including those who never answer.
- **JWT**: a dependency for what HMAC already does.
- **Captchas and third-party services** (Turnstile and others): out of scope by decision ([[challenge-bot-detection]]).
