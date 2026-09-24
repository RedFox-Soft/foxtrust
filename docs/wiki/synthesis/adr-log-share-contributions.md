---
type: synthesis
kind: decision
title: "ADR: log-share attribution of noisy-OR risk to reasons"
tags: [scoring]
created: 2026-09-24
updated: 2026-09-24
sources: []
status: accepted
decided: 2026-09-24
---

# ADR: log-share attribution of noisy-OR risk to reasons

## Context

Every verdict lists `reasons[]`, and their `contribution` values must add up to the risk (FR-003, SC-002). Noisy-OR (`risk = 1 − Π(1 − pᵢ)`) is a product, so the per-signal terms `pᵢ` do not add up to the risk.

## Decision

Split the risk by log-share:

```text
contributionᵢ = risk · ln(1 − pᵢ) / Σⱼ ln(1 − pⱼ)
```

This is exact because `−ln(1 − risk) = Σ −ln(1 − pᵢ)`.

- `pᵢ` is clamped to `1 − 1e-9`.
- Risk and contributions are rounded to 0.1 with the largest-remainder method, so the rounded values add up exactly.
- The capped category part ([[adr-category-only-cap]]) counts as one term and is split among the category signals by their own log-shares.

## Options considered

- **Shapley values:** fair, but exponential in the number of signals and harder to explain.
- **Sequential marginal gains:** the result depends on signal order.
- **Raw `pᵢ`:** does not add up to the risk.

## Consequences

Contributions are deterministic, order-independent and non-negative, and a single signal gets 100 % of the risk. Code: `src/scoring/score.ts`.
