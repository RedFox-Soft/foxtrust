<!--
Sync Impact Report
- Version change: 5.0.0 → 5.1.0 (MINOR: Principle IV materially expanded)
  (previous: 4.0.0 → 5.0.0 MAJOR, Principles II and III; 3.0.0 → 4.0.0 MAJOR, Principle VI;
  2.1.0 → 3.0.0 MAJOR, Principle II; 2.0.0 → 2.1.0 MINOR, Principle V; 1.0.0 → 2.0.0 MAJOR,
  Principle V)
- Modified principles:
  IV. Privacy by Default for First-Party Data: now also covers client-side signals that
      FoxTrust's own code collects in a visitor's browser (challenge page, embeddable snippets):
      processed in memory for one decision only; logs and storage limited to address, time,
      action, bot score and reason codes; no key values, form or page content; no cross-site or
      cross-visit browser identifier; no probing of the visitor's state at other services; a
      returning-device token is first-party, random and carries no client data.
- Decision behind the amendment (2026-10-06): backlog B-12b, before the bot verdict (B-12c) and
  the behavior collector (B-12d); research in docs/wiki/synthesis/challenge-bot-detection.md.
- Added sections: none
- Removed sections: none
- Templates: .specify/templates/*.md read the constitution at runtime; no edits required.
- Dependent artifacts:
  ✅ AGENTS.md: version reference updated to v5.1.0.
  ✅ docs/wiki/synthesis/challenge-bot-detection.md: the proposed rule now points at Principle IV.
  ✅ specs/006-challenge-page: already within the amended rule (no client signals collected).
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

- There are two verdict views of the same data:
  - **Internal verdicts** (operators, delisting, evaluation) MUST include `reasons[]`. Each
    reason has a signal code, source, matched prefix, `lastSeen` and a numeric contribution to
    the final risk.
  - **Customer-facing verdicts** (snapshots, SDK, `/verify`, middleware, public API) MUST
    include `reasons[]`. Each reason has a signal code, `lastSeen` and a contribution: it states
    what the address was seen doing, not who reported it.
- Source and matched prefix MUST NOT appear in customer-facing outputs. They MUST stay stored
  and available to operators and the delisting process.
- Customer-facing verdicts MUST be computed from the signals of shippable feeds only. A feed is
  shippable when its licence allows commercial use and redistribution, or when an accepted ADR
  in `docs/wiki/` records the decision to ship it and its feed page sets `ship: yes`. A feed
  page MAY set `ship: no` to keep the feed out of customer-facing outputs whatever its licence.
- A signal of a non-shippable feed MUST NOT change any customer-facing risk, level, category or
  reason.
- A feed shipped by decision MUST NOT be named in any customer-facing output, including snapshot
  manifests and licence notices.
- Scoring MUST be deterministic and reproducible from stored signals and a snapshot version.
- The risk model MUST stay monotonic and decomposable (noisy-OR:
  `risk = 1 − Π(1 − w·c·decay)`); any replacement model MUST preserve per-signal
  contributions.
- A listed address MUST have a documented path to dispute and delisting.

Rationale: explanations are the product's core differentiator and the basis of delisting.
Customers need to know what an address did. Where the evidence came from is our business, and
some sources forbid being named or redistributed.

### III. Licence-Clean, Traceable Data

- Before a feed is ingested, its licence (commercial use, redistribution) MUST be recorded in
  `docs/wiki/` with the date it was checked.
- Licence facts MUST be recorded as found; a decision to ship a feed MUST NOT change them.
- A feed with unknown or non-commercial terms MUST NOT be included in shipped snapshots or
  commercial API responses unless an accepted ADR records the decision to ship it and its feed
  page sets `ship: yes` (Principle II).
- Aggregated feeds (e.g. FireHOL) inherit the strictest licence of their upstream sources.
- Every stored signal MUST carry its source identifier, `firstSeen` and `lastSeen`.

Rationale: shipping a snapshot in the SDK is redistribution; one bad feed taints every release.
Shipping a feed whose terms do not clearly allow it is therefore a recorded decision with its
reasons, never a default, and it can be withdrawn per feed.

### IV. Privacy by Default for First-Party Data

- Telemetry from integrations (e.g. foxauth) MUST be opt-in and off by default.
- Collected telemetry MUST be limited to the IP, event type, timestamp and integration id;
  usernames, passwords, emails and request bodies MUST NOT be collected.
- Raw first-party events MUST have a documented retention period; only aggregated signals may
  outlive it.
- Client-side signals that FoxTrust's own code collects in a visitor's browser (the challenge
  page, embeddable snippets), such as environment checks and behavior events:
  - MUST be processed in memory for one decision and dropped after it; raw events and
    environment values MUST NOT be logged or stored;
  - MUST leave only the address, time, action, bot score and reason codes in logs and storage;
  - MUST NOT include key values, form contents or page content (key timing only as intervals);
  - MUST NOT be turned into an identifier that recognises a browser across sites or visits; a
    fingerprint or fingerprint hash MUST NOT be stored or used as an identifier.
- FoxTrust MUST NOT probe a visitor's state at other services (login-state detection or any other
  cross-site leak).
- A returning-device token, if used, MUST be first-party to the protected site, random, and carry
  no client data.

Rationale: first-party signals are a competitive advantage only if integrators can trust them. A
challenge that quietly fingerprints visitors or probes their accounts elsewhere would undermine the
explainability and trust the product sells.

### V. Tests for User Cases and Security Only

- Tests MUST be written only for:
  - **User cases**: the acceptance scenarios of the user stories in a feature spec
    (`specs/NNN-name/spec.md`). Each scenario MUST have a test.
  - **Security issues**: a found vulnerability, or behavior whose failure is a security issue.
    Each one MUST have a test that fails without the fix.
- Everything else MUST NOT get dedicated tests: internal modules, helpers, CLI plumbing,
  parsers, normalizers, refactors and configuration. That code is covered only to the extent
  that a user-case or security test exercises it.
- Tests MUST NOT call live networks. They MUST use recorded fixture files.
- Plans and task lists MUST NOT add test tasks outside these two categories.
- Every user-case test name MUST start with its scenario id (e.g. `US1-3: …`), and every
  security test name with `SEC: …`, so coverage is traceable without the spec files.
- Measurements of success criteria are not tests: benchmarks, accuracy evaluation and
  sampling checks. They are allowed, they live in `tests/perf/` or the evaluation tooling, and
  they run on demand, not in the default `bun test` run.

Rationale: tests are spent where a failure hurts a user or opens a hole. Internal code stays
free to change without rewriting a layer of tests.

### VI. Measured Accuracy

- The project MUST maintain a known-good reference: a versioned list of addresses that must never
  be rated `high`, each with a documented public source, kept with the release-gate
  configuration.
- Every snapshot release MUST report the false-positive rate of its customer view on the
  known-good reference, compared with the previous release of the same kind; a regression MUST
  be explained in the release notes before publishing.
- Known-bad accuracy MUST be measured on fresh, reproducible samples of recent threat and
  behavior observations, each address scored with the feed it was sampled from left out. A fixed
  list of known-bad addresses MUST NOT stand in for these samples.
- Evaluations MUST report early detection: the share of addresses later reported by threat or
  behavior feeds that the verdict had already flagged. Release reports MUST include it for an
  earlier release once its window has passed, and it MUST NOT gate publication.
- Release reports MUST NOT include rates over sources that cannot appear in the customer view.
- Changes to weights, half-lives, feeds or policies MUST be evaluated with these measures before
  they ship.

Rationale: without a measured baseline, "better scoring" is an opinion, and a measure is only a
baseline if it moves when the thing it measures changes.

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

**Version**: 5.1.0 | **Ratified**: 2026-09-24 | **Last Amended**: 2026-10-06
