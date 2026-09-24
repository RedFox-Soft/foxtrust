---
type: synthesis
kind: decision
title: "ADR: cap the category part of the risk below high"
tags: [scoring]
created: 2026-09-24
updated: 2026-09-24
sources: []
status: accepted
decided: 2026-09-24
---

# ADR: cap the category part of the risk below high

## Context

A category alone must never produce `high` (constitution Principle I, FR-009). An AWS address is hosting, not an attacker.

## Decision

Combine the category signals first, cap that part at `categoryOnlyMaxRisk` (default 69, validated to be below `levels.high`), then combine it with the behavior part:

```text
cat  = min(1 − Π(1 − pᵢ) over categories, categoryOnlyMaxRisk / 100)
beh  = 1 − Π(1 − pⱼ) over behavior signals
risk = 100 · (1 − (1 − cat)(1 − beh))
```

## Options considered

- **Level-only cap** (risk 80 but level `medium`): confusing to read.
- **Cap the final risk only when no behavior signal exists:** breaks monotonicity. A tiny decayed behavior signal would lift the cap and push a Tor + hosting + bogon address to `high`.
- **Keep all category weights low:** breaks as soon as a new category code is added.

## Consequences

Risk stays monotonic in every signal, and behavior can still take an address to `high`. Measured: 10,000 AWS/GCP addresses with every category code reached at most 69 (SC-003). Contributions are split as in [[adr-log-share-contributions]]. Code: `src/scoring/score.ts`.
