---
type: synthesis
kind: decision
title: "ADR: bot verdict on the challenge page"
tags: [scoring, first-party]
created: 2026-10-06
updated: 2026-10-06
sources: []
status: accepted
decided: 2026-10-06
---

# ADR: bot verdict on the challenge page

Decision for backlog item B-12c (spec 007). It extends [[adr-challenge-page]], where a correct proof-of-work alone earned a pass. The research behind it is in [[challenge-bot-detection]] and [[tls-fingerprints-at-the-proxy]]. Privacy limits: constitution v5.1.0, Principle IV.

## Decision

| Topic | Choice | Why |
|-------|--------|-----|
| Probe | Before solving, the page checks automation markers, engine and user-agent consistency, software rendering, time zone, screen and a notification-permission inconsistency. It sends small derived values in field `p`, bound to the challenge nonce. | Cheap (under 100 ms). Derived values (an engine family, `soft`/`hw`) limit what exists in memory. |
| Server-side evidence | `/verify` compares the probe with the request's own user agent, client hints and `Accept-Language`, and with `X-JA4` from trusted proxies only (JA4 alone, never JA4+). | The probe runs on the attacker's machine; a forged "clean" probe still has to match headers the client really sends. |
| Score | `logit = prior[customer level] + Σ weight[code]`, `P = 1/(1+e^-logit)`. Hand-set weights in `config/bot/<version>.json`, the newest active. | Evidence goes both ways and the address level is a natural prior. Every code's weight is its contribution, so the verdict stays explainable. No trained model (Principle VII). |
| Privacy browsers | A uniform profile (Gecko, a spoofed zone: UTC or `Atlantic/Reykjavik`, `en-US`, outer window reported equal to the inner one) skips the time-zone check. Not tied to Tor exit addresses. | Tor Browser and resistFingerprinting look the same for everyone by design. An exemption by address would also exempt bots on Tor. |
| Policy | Modes `observe` (default), `enforce` and `off`. Thresholds: step-up 0.5, block 0.9. One step-up only; after it `pass` by default, `block` if the operator chooses. | Spec clarifications. A false positive costs a person seconds, not access. |
| Visitor output | Pass, step-up page or `403` page with the manifest's dispute link; never the score or the codes. | Codes would be a bypass guide. |
| Log | `challenge: <action> <address> kind=… bits=… bot=0.99 mode=… [would=…] reasons=code:+w,…`. No probe or header values. | Principle IV; a security test searches the log for every recorded probe value. |
| Labelled set | Samples recorded with `foxtrust bot record`, a separate development command that `verify serve` cannot run, from the developer's own browsers and from automation driven by `tools/bot-samples/` (development-only packages, not in the image). | Licence-clean and privacy-clean. No real visitor is ever recorded. |
| Measurement | `foxtrust bot eval [--compare]` reports pass, step-up and block per label, the human false-positive rate, and SC-001/SC-002. It runs on demand, not in the tests. | Principle VI: weights are measured before they ship. |
| Zone table | `config/bot/zone-countries.tsv` is generated from tzdata `zone1970.tab` and `zone.tab` (2026e, public domain) by `scripts/zone-countries.ts`. | Licence-clean. `zone.tab` adds zones browsers still report, such as `Europe/Oslo`. |
| JA4 families | `config/bot/ja4-families.csv`, reviewed rows only, from our own recordings. Starts empty. | No third-party JA4 database copied before its licence is checked. An empty list adds no penalty. |

## Measurements (2026-10-06, weights 2026-10-06.1)

Recorded automation, two samples each, first attempt, enforce:

| Label | Outcome | Main reasons |
|-------|---------|--------------|
| playwright-chromium-headless | block 2/2 | webdriver, HeadlessChrome (probe and request), software GL, permission inconsistency, no `Accept-Language` |
| puppeteer-headless | block 2/2 | webdriver, HeadlessChrome |
| patchright | block 2/2 | HeadlessChrome, software GL, permission inconsistency, no `Accept-Language` (webdriver hidden) |
| playwright-firefox-headless | step-up 2/2 | webdriver |
| playwright-webkit-headless | step-up 2/2 | webdriver |
| puppeteer-stealth | pass 2/2 | none: the stealth plugin hides every marker the probe checks |
| camoufox (Firefox 156 build) | pass 2/2 | none: a consistent Gecko profile, no automation markers, real `Accept-Language` |

Real browsers, started normally (no automation flags) with throw-away profiles on a Windows 11 PC, two samples each:

| Label | Version | Outcome | Mean score |
|-------|---------|---------|------------|
| chrome-desktop | Chrome 154 | pass 2/2 | 0.05 |
| edge-desktop | Edge 154 | pass 2/2 | 0.05 |
| opera-desktop | Opera 136 | pass 2/2 | 0.05 |
| firefox-desktop | Firefox 157 | pass 2/2 | 0.05 |
| tor-browser-standard | Tor Browser 15.0.24 ("Standard") | pass 2/2 | 0.12 |
| chrome-android | Chrome 154 on Android 10, owner's phone over the LAN | pass 1/1 | 0.05 |
| tor-browser-safer | Tor Browser 15.0.24 ("Safer"), over HTTPS through Caddy, certificate warning accepted by hand | pass 1/1 | 0.12 |

- **SC-001** (no stock headless Playwright or Puppeteer passes): **pass**.
- **SC-002** (real browsers pass): **pass**, with 0 % false positives on the recorded set. Starting weights unchanged.
- **Not yet covered**: Safari and iOS (they need Apple devices) and other Android browsers. "Safer" turns JavaScript off on plain-HTTP pages, so `bot record` needs HTTPS to record it. Until these are recorded, enforce on traffic with many such visitors only after observe mode shows no false positives.
- **SC-003** baseline: puppeteer-stealth and Camoufox pass. Behavior evidence (B-12d) is what must catch them.

## Findings

- **The automation-protocol check (`env.cdp`) never fired.** The check passes an `Error` to `console.debug` and watches its `stack` getter, which stock Playwright and Puppeteer used to trigger. Current Chrome (153–154) no longer triggers it. The check stays with its weight, but nothing should rely on it.
- **Headless Chromium sends no `Accept-Language`** under Playwright and patchright. Puppeteer's new headless sends one.
- **Tor Browser 15 reports the zone `Atlantic/Reykjavik`**, not `UTC`, and does not letterbox to multiples of 100. It reports its outer window equal to the inner one. The uniform-profile rule follows the recording: it matches the spoofed zone and equal window sizes.
- **A Chrome tab opened in the background** reports a 0×0 outer window until it is first shown. Found in a walk-through through Caddy, nginx and Traefik: a real visitor scored 0.62 (step-up) on `env.window_zero`. The page now probes only once the tab is visible.
- **JA4 recordings** (Caddy 2 with `caddy-ja3ja4`, 2026-10-06):

  | Client | First two JA4 parts |
  |--------|---------------------|
  | Chrome 154 | `t13d1518h2_8daaf6152771` |
  | Edge 154 | `t13d1516h2_8daaf6152771` |
  | Firefox 157 | `t13d1517h2_8daaf6152771` |
  | curl 8.14 (Schannel) | `t13d2012h1_2b729b4bf6f3` |
  | Python 3.12 urllib | `t13d181100_85036bcba153` |
  | Node 24 fetch | `t13d5212h1_b262b3658495` |
  | Bun 1.4 fetch | `t13d1713h1_5b57614c22b0` |

  Current Chrome and Firefox share the cipher hash, and the extension count varies between connections of the same browser. Browser-family rows would therefore misclassify, so `ja4-families.csv` holds only the four tool rows, which offer HTTP/1.1 or no ALPN where browsers offer h2. `transport.ja4_mismatch` stays unused until a stable browser distinction is found.
- **Android Chrome over plain HTTP on a LAN address** is not a secure context: no `userAgentData`, no client hints. The engine still resolves to `chromium` through `window.chrome`, so the sample passes. On a real HTTPS site the hints arrive.
- **Recorded over HTTPS** through that Caddy, the Chrome, Edge and Firefox samples also exercise the client-hints rule: no false positive.
- **Tor Browser "Safer"** ignored both the policy that installs the local Caddy root and a `cert_override.txt` in the profile. It was recorded after a manual click-through of the certificate warning. WebGL is off at "Safer" (`gl: unknown`, no evidence). Its JA4 is `t13d1715h2_5b57614c22b0`, the classic Firefox ESR value.
- **The probe's own cost**, measured by `bot record` on the device: 102.6 ms on desktop Chrome 154, 78.4 ms on Chrome 154 on Android 10. It mostly comes from creating a WebGL context. Since `b31bd5e` the probe runs while the worker solves, so it adds nothing to the visitor's wait (SC-004).

## Alternatives rejected

- **A trained classifier on the labelled set**: too few samples, harder to review. Revisit with an ADR when the set grows.
- **Canvas and audio fingerprints, font lists**: they identify browsers (Principle IV) and add little to automation detection.
- **Hashing the probe into the proof-of-work input**: changes spec 006's format and does not stop forged probes.
- **Recording samples from production traffic in observe mode**: forbidden by Principle IV.
- **Exempting Tor or VPN addresses from consistency checks**: bots on Tor would get the same exemption.
