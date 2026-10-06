---
type: synthesis
kind: decision
title: "ADR: returning-device token on the challenge page"
tags: [scoring, first-party]
created: 2026-10-06
updated: 2026-10-06
sources: []
status: accepted
decided: 2026-10-06
---

# ADR: returning-device token on the challenge page

Decision for backlog item B-12e (spec 008).

**Problem**: passes from [[adr-challenge-page]] are bound to the `/32` or `/64`. A visitor whose address changes, through a new Tor circuit, a mobile hand-over, an IPv6 privacy address outside the `/64` or travel, had to solve the proof-of-work again.

**Why not Private Access Tokens**: they would solve this without state, but no issuer is usable by a third party ([[private-access-tokens]]).

**Privacy**: constitution v5.1.0 Principle IV allows a returning-device token that is first-party, random and carries no client data.

## Decision

| Topic | Choice | Why |
|-------|--------|-----|
| Token | Cookie `foxtrust_device`: `{v, id (16 random bytes), h (protected host), exp}`, signed with the challenge secret in its own MAC domain `foxtrust-device/1`. Host-only, `HttpOnly`, `SameSite=Lax`, `Secure`. 30 days, not renewed on use | No address, no client data. The host keeps one `verify` serving several sites from accepting another site's token. The separate domain keeps it from standing in for a pass or a challenge. A stolen token dies on schedule. |
| Use | A valid, unrevoked token under its cap gets a zero-cost challenge (`d = 0`, no wait) carrying the token id. The answer is accepted only with that same token. The bot verdict still runs, with `attest.returning_device` at −1.0 (weights `2026-10-06.2`) | Only the cost is skipped, never the judgment. Binding the cheap challenge to the id stops a client from showing the token to the page and answering without it. |
| Issue | On a pass whose would-be action is pass (or with the verdict off), when no valid token came with the answer | Observe mode never hands tokens to sessions it would have blocked. |
| Cap | At most 20 distinct pass prefixes (`/32`, `/64`) per token per sliding 24 hours, configurable | A day of an active Tor or mobile user, but a shared or stolen token farms at most 20 addresses a day, each judged. |
| Revocation | On a block, or a step-up answer still at or above the step-up threshold, in enforce mode. The response deletes the cookie | A browser caught once loses the shortcut on this site until the token expires. |
| State | Per `verify` instance, in memory and in a JSON file (`FOXTRUST_DEVICE_STATE`, compose volume `verify-state`): token ids, revocation expiries, and per token the prefixes as `HMAC(HMAC(secret, "foxtrust-device-prefix/1"), prefix)` (16 hex characters), kept 24 hours. Saved at most every 5 s and on shutdown, with an atomic rename | Revocations must survive restarts, and `verify` has no database by design. The file holds no address and cannot be tested against guessed addresses without the secret. |

## Measurements (2026-10-06)

`bot eval --with-device` adds the token to every sample of the labelled set:

- **With a weight of −2.0**, stock headless Playwright Firefox and WebKit scored exactly 0.50: still a step-up, at the threshold, one weight change away from a pass.
- **The weight was lowered to −1.0**: those samples now score 0.73 (step-up); Playwright Chromium, Puppeteer and patchright stay blocked. Real browsers stay at about 0.01–0.02, so the token barely matters to them.
- **SC-004** (stock headless gets no pass even with a token) holds. SC-001 and SC-002 still pass.

## Limits

- **Per-instance state**: several `verify` instances keep separate revocations and caps.
- **Evasive automation**: puppeteer-stealth and Camoufox pass the verdict anyway (SC-003 of [[adr-bot-verdict]]). A token they earn lets them skip the proof-of-work on up to 20 addresses a day. Behavior evidence (B-12d) is what closes this.
- **Revocation needs a visit**: a token is revoked only when its browser is caught on this site.

## Alternatives rejected

- **Renewing the token on use**: a stolen token would live forever.
- **Storing addresses or `/64` prefixes in plain text for the cap**: Principle IV; keyed hashes do the job.
- **Memory-only state**: a revoked token would work again after any restart.
- **Letting the token replace the probe**: an automated browser with a good token would pass unjudged.
