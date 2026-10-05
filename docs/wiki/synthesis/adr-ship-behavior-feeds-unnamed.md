---
type: synthesis
kind: decision
title: "ADR: behavior feeds ship to customers without their source"
tags: [data, license, distribution]
created: 2026-10-05
updated: 2026-10-05
sources: [2026-09-24-feed-licence-review]
status: accepted
decided: 2026-10-05
---

# ADR: behavior feeds ship to customers without their source

Supersedes [[adr-customer-facing-behavior-data]].

## Context

Under [[adr-customer-facing-behavior-data]], the three stage 1 behavior feeds stayed internal. Customer verdicts therefore held only network, hosting, Tor and bogon data, which anyone can assemble from the same public lists. The product's differentiator, "what the address did", reached customers only once first-party sensors existed (roadmap stage 4).

Customer-facing verdicts already hide the source and the matched prefix of every reason (constitution Principle II since v3.0.0). A reason says what the address was seen doing, not who reported it.

The licence facts are unchanged: [[spamhaus-drop]], [[feodo-tracker]] and [[blocklist-de]] have `redistribution: unknown` (`docs/raw/2026-09-30-licence-recheck.md`).

## Decision

- **The three behavior feeds ship.** [[spamhaus-drop]] (`hijacked_netblock`), [[feodo-tracker]] (`botnet_c2`) and [[blocklist-de]] (`ssh_bruteforce`, `login_bruteforce`) contribute to customer-facing risk, level and reasons: snapshots, `/verify`, and later the SDK and the public API.
- **Their source is never named** in customer-facing outputs: not in reasons, not in snapshot manifests, not in licence notices, not in release reports.
- **The licence facts stay as found.** The feed pages keep `redistribution: unknown`; the decision is recorded separately as `ship: yes` on each page (constitution v5.0.0, Principles II and III).
- **No permission requests** are sent, as before.
- **[[cymru-fullbogons]] stays local-only.** It is a category feed, and [[iana-address-space]] already provides the shippable `bogon` category.

## Consequences

- **Withdrawal is one line.** If a publisher objects or its terms change, `ship: no` on its page removes the feed from the next release: the next ingestion run marks the feed's stored signals as non-shippable, and the next hourly delta drops them.
- **The public early-detection figure** in release reports becomes available: it no longer waits for first-party data ([[adr-accuracy-measures]]).
- **Disputes** cover behavior listings too. The process in `docs/dispute.md` already explains reasons without naming the reporter; operators check the source internally.
- **Honeypots** (roadmap stage 4) are no longer the only path to customer-facing behavior data. They remain the way to depend less on third-party feeds and to obtain independent known-bad labels.
- **Accepted risk:** the Spamhaus terms grant no IP licence and can be revoked; the abuse.ch terms forbid derivative works without consent; blocklist.de states no licence. The decision accepts that risk and relies on hiding the source plus per-feed withdrawal.
