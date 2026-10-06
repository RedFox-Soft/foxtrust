---
type: synthesis
title: "Private Access Tokens (Privacy Pass) for the challenge page"
tags: [license, open-question]
created: 2026-10-06
updated: 2026-10-06
sources: []
---

# Private Access Tokens (Privacy Pass) for the challenge page

Research for backlog item B-12f (attestation layer of [[challenge-bot-detection]]), checked 2026-10-06. The idea: the challenge page ([[adr-challenge-page]]) answers with `401 WWW-Authenticate: PrivateToken …` (RFC 9577). A supporting client then returns a token from a trusted issuer (RFC 9576 architecture, RFC 9578 issuance), and the visitor passes with no proof-of-work.

**Bottom line**: no public issuer exists that a third-party origin may use in production. Verification is easy to build; issuance is the blocker.

## Issuers

| Issuer | Directory | Token type | Origin registration | Terms for production use | Usable for FoxTrust |
|--------|-----------|------------|---------------------|--------------------------|---------------------|
| Cloudflare demo | `demo-pat.issuer.cloudflare.com/.well-known/private-token-issuer-directory` (live) | 0x0002 | none | none found; docs: "the demo issuer is open for testing"; keys rotate about daily | **no**: test only |
| Fastly demo | `demo-issuer.private-access-tokens.fastly.com/.well-known/token-issuer-directory` (legacy path) | 0x0002 | none | blog: "supports any origin (and is for development only!)"; keys rotate about weekly | **no**: development only |
| Cloudflare production (`pat-issuer.cloudflare.com`) | directory behind Cloudflare Access (403) | 0x0002 | "not a self-serve product… a managed engagement with Cloudflare" | unknown | **unknown**: needs a sales engagement |
| Cloudflare Research (Silk extension) | `pp-issuer-public.research.cloudflare.com/...` (live, static key since 2023-10-30) | 0x0002 | none | none found; "used for research"; attester needs a Turnstile interaction | **no**: research only, not zero-click |
| Own issuer registered with Apple | — | 0x0002 | Apple onboarding at register.apple.com (2022: registration to open "late this year") | unknown | **unknown**: current status could not be confirmed |
| Google, Brave, Kagi | none public | — | — | — | **no**. Chrome's `hasPrivateToken` is Private State Tokens, a different protocol |

Apple (2022-06-09): "You can test with token issuers from Cloudflare and Fastly". There is no statement that a third-party origin may use them in production.

## Clients

- **Who sends tokens**: Safari, WebKit and URLSession on iOS 16+, iPadOS 16.1+ and macOS Ventura+ answer automatically, if the user is signed in to an Apple Account with "Automatic Verification" on (the default). Safari fetches tokens only for issuers Apple trusts.
- **Other browsers**: Chrome and Firefox only through Cloudflare's Silk extension, which needs interaction.
- **Traffic share**: no published numbers; Safari on Apple devices is only an upper bound.

## Verification (if an issuer becomes available)

- **Format**: a type-2 token is `token_type | nonce | SHA-256(TokenChallenge) | token_key_id | authenticator`. It is checked with RSASSA-PSS (SHA-384, MGF1-SHA-384, 48-byte salt) against the issuer's public key from its directory. No call to the issuer is needed.
- **Double spend**: RFC 9577 §2.2.2 says origins SHOULD prevent it. A per-challenge `redemption_context` keeps the needed state minimal: a short-lived store, like the challenge page's replay cache.
- **Challenge placement**: the challenge must come from a first-party domain on a `401`. The page can answer `401 WWW-Authenticate: PrivateToken` with the proof-of-work HTML as the body, which is the fallback for clients without tokens. The forward-auth `302` to the page is fine.
- **Bun**: `crypto.subtle.importKey("spki")` rejects the id-RSASSA-PSS SPKI on Bun 1.4.2. A small DER parse that extracts n and e, then a JWK import and `crypto.subtle.verify({name: "RSA-PSS", saltLength: 48})`, works with no dependency. Estimate: 200–300 lines. Running our own issuer adds RSA blind signing (about 100 lines) plus Apple onboarding.

## Decision for the backlog

- **B-12e**: the returning-device token goes first. Private Access Tokens wait until a production issuer is available: Apple onboarding of our own issuer, or terms from Cloudflare.
- Demo issuers are never used outside tests: their terms allow testing and development only, and their keys rotate.

## Open questions

- Is Apple's issuer onboarding (register.apple.com) open today, what does it require, does it cost?
- Would Cloudflare's production issuer serve a non-customer origin, and on what terms?
- Apple's per-origin token rate limits (not published).

## Sources

- RFCs: https://www.rfc-editor.org/rfc/rfc9576, https://www.rfc-editor.org/rfc/rfc9577.html, https://www.rfc-editor.org/rfc/rfc9578.html
- Cloudflare: https://developers.cloudflare.com/privacy-pass/getting-started/, https://developers.cloudflare.com/privacy-pass/production-deployment-testing/, https://developers.cloudflare.com/privacy-pass/concepts/deployment-models/, https://github.com/cloudflare/pp-browser-extension, https://blog.cloudflare.com/privacy-pass-standard
- Fastly: https://www.fastly.com/blog/private-access-tokens-stepping-into-the-privacy-respecting-captcha-less, https://www.fastly.com/documentation/solutions/demos/pat/
- Apple: https://developer.apple.com/news/?id=huqjyh7k, https://developer.apple.com/videos/play/wwdc2022/10077/, https://developer.apple.com/forums/thread/709455, https://support.apple.com/en-gb/102591
- Others: https://blog.kagi.com/kagi-privacy-pass
