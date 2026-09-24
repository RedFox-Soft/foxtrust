<!--
Sync Impact Report
- Version change: template (unversioned) → 1.0.0
- Principles (all new):
  I. Category and Behavior Are Separate Layers
  II. Explainable Verdicts
  III. Licence-Clean, Traceable Data
  IV. Privacy by Default for First-Party Data
  V. Test-First Core (NON-NEGOTIABLE)
  VI. Measured Accuracy
  VII. Open Formats and Simplicity
- Added sections: Technology and Data Constraints; Development Workflow; Governance
- Removed sections: none
- Templates: .specify/templates/*.md read the constitution at runtime; no edits required
  (plan-template "Constitution Check" gates are derived from this file).
- Deferred TODOs: none
-->

# FoxTrust Constitution

## Core Principles

### I. Category and Behavior Are Separate Layers

- Network facts (categories: hosting, cloud, VPN, Tor, proxy, mobile carrier, residential, bogon)
  and observed activity (behavior: brute force, spam, scanning, credential stuffing, C2) MUST be
  modelled, stored and scored as distinct signal kinds.
- A category alone MUST NOT produce a `high` risk level.
- Behavior signals MUST decay with a declared half-life; category signals MAY be non-decaying.
- Allow/challenge/block decisions MUST be expressed as policies evaluated over verdicts, never
  hard-coded into scoring.

Rationale: mixing "what it is" with "what it did" is the main source of false positives in
existing IP reputation services.

### II. Explainable Verdicts

- Every verdict MUST include `reasons[]`, each with signal code, source, `lastSeen` and
  numeric contribution to the final risk.
- Scoring MUST be deterministic and reproducible from stored signals and a snapshot version.
- The risk model MUST stay monotonic and decomposable (noisy-OR:
  `risk = 1 − Π(1 − w·c·decay)`); any replacement model MUST preserve per-signal
  contributions.
- A listed address MUST have a documented path to dispute and delisting.

Rationale: explanations are the product's core differentiator and the basis of delisting.

### III. Licence-Clean, Traceable Data

- Before a feed is ingested, its licence (commercial use, redistribution) MUST be recorded in
  `docs/wiki/` with the date it was checked.
- A feed with unknown or non-commercial terms MUST NOT be included in shipped snapshots or
  commercial API responses.
- Aggregated feeds (e.g. FireHOL) inherit the strictest licence of their upstream sources.
- Every stored signal MUST carry its source identifier, `firstSeen` and `lastSeen`.

Rationale: shipping a snapshot in the SDK is redistribution; one bad feed taints every release.

### IV. Privacy by Default for First-Party Data

- Telemetry from integrations (e.g. foxauth) MUST be opt-in and off by default.
- Collected telemetry MUST be limited to the IP, event type, timestamp and integration id;
  usernames, passwords, emails and request bodies MUST NOT be collected.
- Raw first-party events MUST have a documented retention period; only aggregated signals may
  outlive it.

Rationale: first-party signals are a competitive advantage only if integrators can trust them.

### V. Test-First Core (NON-NEGOTIABLE)

- Core modules MUST be developed test-first (red → green → refactor): scoring and decay,
  policy evaluation, feed parsers and normalizers, IP/CIDR matching (IPv4 and IPv6), MMDB
  writing and reading.
- All other code MUST ship with tests in the same commit as the behavior change.
- Feed parsers MUST be tested against recorded fixture files, not live network calls.

Rationale: errors in the core silently mislabel real users at scale.

### VI. Measured Accuracy

- The project MUST maintain a labelled set of known-good and known-bad addresses.
- Every snapshot release MUST report its false-positive and false-negative rates against that
  set; a regression MUST be explained in the release notes before publishing.
- Changes to weights, half-lives or policies MUST be evaluated against the labelled set.

Rationale: without a measured baseline, "better scoring" is an opinion.

### VII. Open Formats and Simplicity

- Snapshots MUST be valid MMDB readable by standard MaxMind reader libraries, and MUST be
  signed.
- Prefer native PostgreSQL features (`inet`/`cidr`, GiST) and Bun built-ins over extra
  dependencies; each new runtime dependency MUST be justified in the feature plan.
- Start with the simplest model that satisfies the principles above; ML or new infrastructure
  requires a recorded decision (ADR) in `docs/wiki/`.

Rationale: open formats drive adoption without our SDK; fewer moving parts keep a small team fast.

## Technology and Data Constraints

- Runtime and package manager: Bun. HTTP framework: Elysia. Language: TypeScript in strict mode.
- Storage: PostgreSQL. IP addresses and ranges MUST use `inet`/`cidr` types; range lookups MUST
  be index-backed (GiST or equivalent).
- IPv4 and IPv6 MUST be supported equally in storage, scoring, API and snapshots.
- Public API is versioned by path (`/v1/...`); breaking changes require a new version.
- Snapshots: full release daily, delta hourly; each carries a `snapshotVersion`.
- All code, comments, docs, specs and wiki pages are written in English.

## Development Workflow

- Features follow Spec Kit: `/speckit-specify` → `/speckit-plan` → `/speckit-tasks` →
  `/speckit-implement`; artifacts live in `specs/NNN-name/`.
- Every plan MUST pass a Constitution Check against Principles I–VII; violations MUST be listed
  in the plan's complexity tracking with justification.
- Design decisions and feed/provider research are recorded in `docs/wiki/` (ADRs as
  `synthesis` pages with `kind: decision`).
- Commits follow Conventional Commits 1.0.0 and contain no AI attribution trailers
  (see `AGENTS.md`).

## Governance

- This constitution supersedes other project practices; `AGENTS.md` provides runtime guidance
  for agents and MUST NOT contradict it.
- Amendments are made by editing this file in a dedicated commit
  (`docs: amend constitution to vX.Y.Z`) with an updated Sync Impact Report.
- Versioning follows semantic versioning: MAJOR for removing or redefining a principle, MINOR
  for adding a principle or materially expanding guidance, PATCH for clarifications.
- Compliance is checked in every `/speckit-plan` Constitution Check and `/speckit-analyze` run;
  unresolved violations block implementation.

**Version**: 1.0.0 | **Ratified**: 2026-09-24 | **Last Amended**: 2026-09-24
