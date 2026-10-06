---
type: synthesis
title: "TLS and HTTP/2 fingerprints at the proxy (JA4 for /verify)"
tags: [license, scoring, open-question]
created: 2026-10-06
updated: 2026-10-06
sources: []
---

# TLS and HTTP/2 fingerprints at the proxy (JA4 for /verify)

Research for backlog item B-12f (transport layer of [[challenge-bot-detection]]), checked 2026-10-06. `/verify` sits behind the operator's reverse proxy and never sees the TLS handshake, so a fingerprint can reach it only as a header set by the proxy that terminates TLS.

**Main constraint**: a fingerprint describes the TLS client the proxy itself talks to. Behind Cloudflare Tunnel → Traefik (the home server, [[adr-production-hosting]]), the handshake Traefik sees comes from `cloudflared`, not from the visitor. Only Cloudflare sees the visitor's ClientHello there.

## Per proxy

| Proxy | Option | Custom build | Activity | Licence | Value |
|-------|--------|--------------|----------|---------|-------|
| nginx | FoxIO ja4-nginx-module | yes (nginx patch; nginx 1.30.0 + OpenSSL 4.0.0 source) | commit 2026-10-01; tag v1.3.1-beta 2024-11-15 | FoxIO License 1.1 (whole repo) | `$http_ssl_ja4`, `$http_ssl_ja4h`, `$http_ssl_ja4t`, … |
| nginx | phuslu/nginx-ssl-fingerprint | yes (patches nginx **and** OpenSSL) | v1.0.5 2026-04-19 | BSD-2-Clause | `$http_ssl_ja3`, `$http_ssl_ja4`, `$http2_fingerprint` (Akamai-style) |
| nginx | fooinha/nginx-ssl-ja3 | yes (nginx patch) | JA4 only on an experimental branch | BSD-2-Clause | `$http_ssl_ja3` |
| Traefik | none | — | built-in JA3 request declined (issue #8627); plugins cannot read the ClientHello (issue #12421 open) | — | **not possible** |
| Caddy | josuebrunel/caddy-ja3ja4 | yes (`xcaddy`) | v0.3.0 2026-10-03, young | MIT | `{tls.ja3}`, `{tls.ja4}` |
| Caddy | inkress/caddy-ja4 | yes (`xcaddy`) | v0.2.1, young | MIT | `X-JA4` header |
| HAProxy | O-X-L Lua plugins (JA4, JA4H) | no, HAProxy ≥ 3.1 + capture buffer | last commit 2026-02-27 | MIT | Lua-computed |
| Envoy | `tls_inspector` `enable_ja4_fingerprinting` | no (native) | merged 2025-05-15 (first release unknown) | Apache-2.0 | `%TLS_JA4_FINGERPRINT%` |
| Cloudflare | Bot Management fields, managed transform "Add bot protection headers" (`cf-ja4`, `cf-ja3-hash`) | — | docs 2026-05-06, 2026-09-24 | — | **Enterprise plan with Bot Management only** |

Caddy modules without a licence (matt-/caddy-ja4, bangnokia/caddy-ja4) are not usable.

## Licence of JA4 and JA4+

- **JA4 (TLS client)**: BSD-3-Clause. "THIS LICENSE IS FOR JA4 ONLY (TLS CLIENT FINGERPRINTING) AND NOT FOR THE REST OF JA4+". FoxIO states no patent claims for JA4. Commercial use allowed.
- **JA4S, JA4H, JA4L, JA4X, JA4T, JA4SSH and the rest**: FoxIO License 1.1, "patent-pending".
  - Use is allowed "only for non-commercial purposes", and "Providing the software on a hosted or managed service basis to others is not a non-commercial purpose".
  - The licence FAQ adds that a company using JA4+ "to provide value to paying customers, even without exposing JA4+ fingerprints directly to those customers" needs an OEM licence.
- **Consequence for FoxTrust**: a customer verdict may use **JA4 only** (and legacy JA3). JA4H, JA4T and the other JA4+ methods are out unless FoxIO grants an OEM licence, even when the customer's proxy computes the value.

## Conclusions for the bot verdict (B-12c)

- An optional header (`X-JA4`, perhaps `X-JA3`) is read only from `FOXTRUST_TRUSTED_PROXIES`, since clients can forge it. Most operators will not send it, so the transport layer is an optional bonus signal, never required.
- Setup guides cover the options that work without licence risk: Envoy (native) and phuslu's nginx module (BSD, also JA3 and HTTP/2). Mention, with caveats: FoxIO's nginx module (FoxIO licence on the repo), Caddy caddy-ja3ja4, the HAProxy Lua plugin. State plainly that Traefik cannot provide it.
- The home server (Tunnel → Traefik) has no visitor fingerprint without Cloudflare Enterprise + Bot Management. Dogfooding B-12c there tests every layer except transport.

## Own recordings (2026-10-06)

Caddy 2 with caddy-ja3ja4, built with `xcaddy` in Docker, worked with no other configuration (`ja3_ja4` directive, `{tls.ja4}` placeholder, `header_up X-JA4 {tls.ja4}`). Values are in [[adr-bot-verdict]].

- **Chrome 154, Edge 154 and Firefox 157** share the cipher hash `8daaf6152771`, and their extension counts differ by one or two between connections. The first two JA4 parts do not separate browser families reliably.
- **Tools** (curl/Schannel, Python urllib, Node and Bun fetch) are distinct, and they offer HTTP/1.1 or no ALPN where browsers offer h2.

## Open questions

- Does the JA4 code inside ja4-nginx-module fall under BSD-3 or FoxIO 1.1? The repo LICENSE is FoxIO 1.1, but its Software line does not list JA4. Ask FoxIO.
- Licence of the Akamai HTTP/2 fingerprint method.
- First Envoy release with JA4; whether HAProxy Enterprise has native JA4.
- Whether Cloudflare Tunnel delivers `cf-ja4` to the origin (needs an Enterprise zone to test).

## Sources

- FoxIO JA4: https://github.com/FoxIO-LLC/ja4 (README, LICENSE, LICENSE-JA4, License FAQ); https://github.com/FoxIO-LLC/ja4-nginx-module
- nginx: https://github.com/phuslu/nginx-ssl-fingerprint, https://github.com/fooinha/nginx-ssl-ja3
- Traefik: https://github.com/traefik/traefik/issues/8627, https://github.com/traefik/traefik/issues/12421, https://community.traefik.io/t/is-there-a-way-to-get-the-tls-client-hello-in-a-plugin/26557
- Caddy: https://github.com/josuebrunel/caddy-ja3ja4, https://github.com/inkress/caddy-ja4, https://github.com/exaring/ja4plus
- HAProxy: https://github.com/O-X-L/haproxy-ja4-fingerprint
- Envoy: https://github.com/envoyproxy/envoy/blob/main/api/envoy/extensions/filters/listener/tls_inspector/v3/tls_inspector.proto
- Cloudflare: https://developers.cloudflare.com/bots/additional-configurations/ja3-ja4-fingerprint/, https://developers.cloudflare.com/rules/transform/managed-transforms/reference/, https://developers.cloudflare.com/workers/runtime-apis/request/
