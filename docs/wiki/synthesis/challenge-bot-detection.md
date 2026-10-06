---
type: synthesis
title: "Challenge page: telling humans from bots without a captcha"
tags: [scoring, first-party, open-question]
created: 2026-10-06
updated: 2026-10-06
sources: []
---

# Challenge page: telling humans from bots without a captcha

Research for backlog item B-12, the page that `/verify` sends `challenge` decisions to and that issues the pass token `/verify` already checks (`src/verify/token.ts`). Goal: no captcha to solve. The page computes a **bot verdict** for the browser session the way the core computes one for an address, and a policy turns it into pass, step-up or block. The first part, a proof-of-work page without client signals (B-12a), is built: [[adr-challenge-page]]. The environment and transport layers with the log-odds verdict (B-12c) are built: [[adr-bot-verdict]]. The returning-device token (B-12e) is built: [[adr-returning-device]].

## Decided (2026-10-06)

- **No captcha by default.** Proof comes from cost, environment, behavior and attestation.
- **No login-state probing** of other services (XS-Leaks such as an `<img>` pointed at a provider's login redirect). Reasons: browsers treat it as a vulnerability and keep closing it (third-party cookie blocking, `SameSite=Lax` default); bot operators buy "aged" profiles with real cookies, so it fails exactly against serious bots; it reads data about the person's accounts elsewhere without consent, which contradicts constitution Principle IV and the explainability positioning. Legitimate replacements are listed under attestation below.

## Bot verdict: layers

| Layer | Signals | Observed by | Notes |
|-------|---------|-------------|-------|
| Network (prior) | Customer verdict of the address: categories and behavior | snapshot, already in `/verify` | Sets the starting probability and the PoW difficulty |
| Transport | JA4 TLS fingerprint (not JA4+) vs the claimed browser | the TLS-terminating proxy, passed as a header | Optional; works with nginx/Caddy modules and Envoy, not Traefik, Cloudflare only on Enterprise ([[tls-fingerprints-at-the-proxy]]) |
| Environment | Automation markers; consistency between layers | page script + request headers | See below |
| Behavior | Pointer, key timing, touch, scroll, focus, `isTrusted` | page script | See below |
| Attestation | Private Access Tokens, returning-device token, passkey | page | Lowers the probability; never raises it |
| Cost | Proof-of-work solved | page script (Web Worker) | Not a human test: raises the price per token |

### Environment

- **Automation markers** (cheap, catch lazy bots): `navigator.webdriver`, side effects of the CDP `Runtime.enable` call that Playwright and Puppeteer make, driver globals, `HeadlessChrome` in the user agent. Patched builds (patchright, rebrowser-patches, nodriver, Camoufox) remove them, and Chrome's new headless mode matches headful Chrome.
- **Consistency** (stronger, because every layer must be faked at once): user agent vs `Sec-CH-UA` vs `navigator.userAgentData` vs engine features; WebGL renderer (SwiftShader or llvmpipe means no GPU) vs the claimed platform; `Intl` time zone and `Accept-Language` vs the country of the address; screen and window sizes (`outerWidth = 0`, window larger than screen).
- Computed as reason codes on the fly. No fingerprint is stored or used to recognise a person.

### Behavior

- Events: `pointermove`/`mousemove`, `pointerdown`, key-down/key-up intervals (never key values), `touch*`, `scroll`, `focus`/`blur`, `visibilitychange`, and `isTrusted` on each.
- Features: path noise and micro-corrections vs straight lines, Bézier curves (ghost-cursor) or teleports; velocity spread; time to first event; key interval distribution. `isTrusted = false` means `dispatchEvent`; CDP `Input.dispatchMouseEvent` still yields `isTrusted = true`.
- **Payload**: compact encoding, encrypted with a per-challenge key, bound to the server nonce and the PoW solution so it cannot be replayed; the script is mangled per build. Obfuscation only slows reverse engineering (commercial vendors rotate VM-based obfuscators daily); the real defence is server-side consistency checks.
- **Limits**: a PoW page that finishes in 1–3 s collects almost no input, so good behavior data comes from pages where people act (a login form) through an embeddable snippet, which overlaps the SDK (B-11). Touch-only and keyboard-only users and screen-reader users produce few or no pointer events: absence of events may step up the challenge, never block.

### Attestation (legitimate "trust from elsewhere")

- **Private Access Tokens / Privacy Pass** (RFC 9576–9578): a trusted issuer vouches for a real device without revealing who it is. Mostly Apple platforms. No public issuer may be used by a third-party origin in production yet, so this waits ([[private-access-tokens]]).
- **Returning-device token**: a long-lived first-party cookie issued after a clean pass, not bound to the address. Also fixes re-challenges when a Tor exit or an IPv6 privacy address changes.
- **Passkey / WebAuthn, FedCM sign-in**: voluntary step-up chosen by the person.

### Combining: log-odds, not noisy-OR

Noisy-OR (the risk model) only accumulates evidence of harm. Here evidence points both ways, so the bot verdict is a sum of log-odds:

```
logit(P(bot)) = prior(address risk) + Σ wᵢ·signalᵢ − Σ wⱼ·attestationⱼ
```

- Weights live in a versioned config like the scoring config and are tuned on a labelled set: recorded probe payloads from real browsers (desktop and mobile) and from Playwright, Puppeteer, puppeteer-stealth, patchright and Camoufox runs. This is a measurement in the eval tooling, not a test.
- **Policy over the verdict** (constitution: decisions are policies): pass, step-up (harder PoW, time-lock wait, behavior step such as press-and-hold), or block.
- **Reasons** carry codes such as `env.webdriver`, `env.ua_mismatch`, `behavior.no_trusted_input`, `attest.pat`. They go to the operator log only; the client learns nothing, or the reasons become a bypass guide. This is a third verdict view and needs a decision in the spec.
- **Feedback loop**: failed challenges per address can become a first-party behavior signal (`challenge_fail`), an input to stage 4a.

## Flow constraints found in the code

- **Cookie domain.** `/verify` reads the `foxtrust_pass` cookie (or `X-FoxTrust-Pass`) on the protected host. A page on `foxtrust.dev` cannot set that cookie, so the page must be served by the `verify` service on a path of the protected host that the proxy routes to it, or hand the token to a callback on that host.
- **Open redirect.** `?return=` must stay on the protected host.
- **Address binding.** Tokens bind the exact address; Tor exits, IPv6 privacy addresses and mobile CGNAT change it. Spec 006 binds IPv6 passes to the `/64` and keeps IPv4 exact; returning-device tokens (B-12e) cover the rest.
- **What a token buys.** A stateless token allows unlimited requests until `exp`, so one PoW is cheap against credential stuffing. TTL must be short; rate limits remain the application's job (step-up in foxauth, B-40).
- **No JavaScript.** Tor Browser at "Safest" runs no script. Fallback: a signed time-lock nonce (`notBefore = now + N s`) submitted by `<meta http-equiv="refresh">`. Weak, because a bot can choose it and pay only with waiting time, so it is off by default and the operator turns it on (spec 006).

## Privacy

Constitution v5.1.0 (2026-10-06) extends Principle IV to client signals: raw events and environment values are processed in memory for one decision and dropped; logs and storage keep only the address, time, action, bot score and reason codes; no key values, form or page content; no identifier that recognises a browser across sites or visits; no probing of other services; a returning-device token is first-party, random and carries no client data.

## Open questions

- Cloudflare Turnstile as an optional operator-chosen step-up provider (external service, needs an ADR) or strictly in-house.
- Whether client-side reason codes form a third verdict view or stay operator log only.
- Legal basis for client-side signal collection (security purpose under GDPR and ePrivacy Art. 5(3)); not checked.
