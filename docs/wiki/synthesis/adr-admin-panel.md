---
type: synthesis
kind: decision
title: "ADR: operator admin panel behind foxauth, with releases carried out by the scheduler"
tags: [operations, architecture]
created: 2026-10-08
updated: 2026-10-08
sources: []
status: accepted
decided: 2026-10-08
---

# ADR: operator admin panel behind foxauth, with releases carried out by the scheduler

Decision for backlog item B-16 (spec 011). It adds a fifth service to the stack of [[adr-publication-topology]] and the interface for the account and key service of [[adr-public-api]].

**Problem**: keys were issued with a one-off script, held releases and runs needed a shell on the server, and alerts arrived only in Telegram. The operator needs one place to act, which must be safe: it can revoke customers' keys and publish data to every customer.

## Decision

| Topic | Choice | Why |
|-------|--------|-----|
| Identity | foxauth OIDC, authorization code + PKCE (S256), confidential client (`client_secret_basic`). ID token checks: `RS256` only, JWKS `kid` with one refetch, `iss`, `aud`/`azp`, `exp`/`iat` (60 s skew), `nonce`; `state`; the `iss` response parameter (RFC 9207). No library: `node:crypto` verifies signatures | foxauth's discovery offers exactly this; the checks are standard and short; Principle VII |
| Who gets in | Members of the foxauth bucket group `foxtrust-operators`, read from the `groups` claim (scope `groups`), compared without case; a distributed claim (above 200 groups) is read from userinfo | Operators are managed in foxauth, not in FoxTrust's settings; foxauth's group design is RedFox-Soft/OAuth-server.ts#62 |
| foxauth setup | A user bucket "FoxTrust staff" (registration closed, TOTP required) assigned to a project "FoxTrust Admin" holding the panel's client; the group lives in that bucket | The instance's default bucket has open registration and no second factor; operators stay apart from customers (B-15) |
| Sessions | Server-side rows: the cookie (`__Host-`, `HttpOnly`, `SameSite=Lax`, `Secure`) holds a random 256-bit id; the table keeps its SHA-256. 8 hours, never extended. Sign-out deletes the row and goes on to foxauth's `end_session_endpoint` | Sign-out must end a session at once; a stolen database row is not a usable cookie |
| Pages | Server-rendered, no script at all; strict CSP (`default-src 'none'`, own fonts, `frame-ancestors 'none'`), `X-Frame-Options: DENY`, `no-store`. Confirmations are pages of their own | No script means no XSS sink to defend |
| Styles | Beer CSS (Material Design 3, MIT): the npm package `beercss`, pinned at 5.0.3; its stylesheet and icon font are served from the panel's origin, plus a small `admin.css`. Without its script: labels float through `placeholder=" "`; the dark theme applies through `prefers-color-scheme`; the server strips the CDN font fallbacks when it loads the stylesheet | The owner's choice; a package keeps the version visible and updatable; only static files are used (Principle VII, justified in the plan); reusable by the site (B-15) |
| Changes | Form posts only, with the session's CSRF token, an `Origin` equal to the panel, and `Sec-Fetch-Site` same-origin when sent | SameSite alone does not cover same-site subdomains |
| Releases and held runs | The panel inserts an `operator_request` (one pending per item); the scheduler runs a pass every minute and carries it out as `snapshot publish --release-note` and `feeds confirm` do, then marks it done or failed with the reason | The signing key and the feed artifacts live only in the scheduler; a second copy of the key would be the worst place to save effort |
| Audit | Every change, and every sign-in and refusal, with foxauth subject, name, action, item, time and the release note; no secret, cookie or token; kept 400 days | Who released a held snapshot, and why, must be answerable later (Principle VI) |
| Network | Compose service `admin` with no host port; the tunnel reaches it on the compose network behind Cloudflare Access; the panel's own sign-in holds even if the gate is misconfigured | Two independent layers |
| foxauth down | The panel starts and serves existing sessions; sign-in shows "unavailable" and retries discovery at most every 30 s. An issuer mismatch is a configuration error (exit 2) | An outage of the identity provider must not lock out an operator who is already signed in |

## Measurements (2026-10-08)

- **SC-005** (pages under 1 s with 10,000 keys and a year of usage, development machine): overview 9 ms, key list 43 ms, a key's page 67 ms, an account 74 ms (worst of 5).
- **Scenario and security tests**: 16 and 5 against a fake OIDC provider shaped like foxauth's discovery; no live foxauth in tests.

## Limits

- **Removing an operator** takes effect at their next sign-in, at most 8 hours later; a revocation in foxauth does not reach an open session.
- **Release requests wait** while the scheduler runs without the signing key; the overview shows how long.
- **One panel instance** is assumed; sessions are in the database, so a second instance would work, but nothing needs it.

## Alternatives rejected

- **Cloudflare Access identity alone**: the panel would trust a header that a misconfigured gate drops, and operators would be managed outside foxauth.
- **A list of operator subjects in FoxTrust's settings**: adding an operator would need a restart and a file edit.
- **An OIDC library** (`openid-client`): a dependency for a few standard checks.
- **A single-page front end**: script, a build and a bundle for a few tables and forms.
- **Giving the panel the signing key**, or an HTTP channel to the scheduler: a second key copy, or a listener the scheduler does not have.
- **Command-line key management** (dropped in spec 010): the panel and later the site are the interfaces.
