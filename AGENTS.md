# Agent Instructions

FoxTrust / IP Trust: IP reputation service. Overview and roadmap: `README.md`.

## Language
- Write everything in English: code, comments, commit messages, docs, specs, wiki pages.

## Stack
- Runtime and package manager: **Bun** (`bun install`, `bun test`, `bun run`). Do not use npm/yarn/pnpm or Node-only APIs when a Bun API exists.
- HTTP: **Elysia**. Language: **TypeScript** (strict).
- Database: **PostgreSQL**. Store IPs and ranges as `inet`/`cidr` and index them with GiST; do not store IPs as text or integers.
- Commands:
  - `bun install`; `docker compose up -d db` (PostgreSQL 18); copy `.env.example` to `.env`.
  - `docker compose up -d --build scheduler` runs scheduled ingestion in a container. Docker restarts it; the healthcheck watches its heartbeat. Rebuild after changing licence pages.
  - `bun test` runs the acceptance and security tests and needs `DATABASE_URL_TEST`.
  - `bun run typecheck` (TypeScript 7, installed as `@typescript/native`); `bun run lint` (ESLint with typescript-eslint, which reads the TS 6 API: the `typescript` package is aliased to `@typescript/typescript6` until typescript-eslint supports TS 7); `bun run bench` (success-criteria measurements, on demand).
  - `bun run foxtrust <command>`: `db migrate`, `config check|activate`, `ingest`, `schedule`, `feeds status|confirm`, `lookup`, `retention run`, `eval`, `keys generate|add`, `snapshot build|publish|list|at|verify|retention run`, `publication serve`, `verify serve`, `policy check`.
  - `docker-compose.yml` services: `db`, `scheduler` (ingestion + snapshot jobs; the only holder of the signing key secret), `publication` (read-only `/v1/` files, port 8081), `verify` (forward-auth, no database, port 8080).
- No runtime dependencies: use Bun built-ins (`Bun.sql`, `Bun.cron`, `Bun.YAML`). Justify any new dependency in the feature plan.

## Domain Rules
- Keep network **categories** (hosting, vpn, tor, bogon…) separate from **behavior** signals (bruteforce, spam, scan…). Never collapse them into one flag.
- Behavior signals decay (`halfLifeHours`); categories decay slowly or not at all.
- Risk is noisy-OR: `1 − Π(1 − w·c·decay)`.
- Two verdict views. Internal verdicts carry `reasons[]` with code, `source`, prefix, `lastSeen`, `contribution`. Customer-facing verdicts (snapshots, SDK, `/verify`, middleware, API) carry code, `lastSeen`, `contribution` only, never the source or prefix, and are computed from shippable feeds only.
- Block/allow is a **policy** over verdicts, not part of scoring.
- Before adding a feed, record its licence (commercial use, redistribution) in `docs/wiki/entities/`. A feed ships when both are `yes`, or when its page sets `ship: yes` backed by an ADR; `ship: no` withdraws it. Licence facts stay as found.
- Snapshot format is MMDB; it must stay readable by standard MaxMind readers.
- Never commit the snapshot signing key; it is a Docker secret (`FOXTRUST_SIGNING_KEY`).

## Workflow
- Feature specs: spec-kit skills (`/speckit-specify` → `/speckit-plan` → `/speckit-tasks` → `/speckit-implement`). Output goes to `specs/NNN-name/`.
- Principles: `.specify/memory/constitution.md` (v5.0.0). It overrides this file on conflict; amend via `/speckit-constitution`.

## Tests
- Write tests **only** for user cases (acceptance scenarios of the user stories in `specs/NNN-name/spec.md`) and for security issues.
- Skip everything else: no dedicated tests for internal modules, helpers, CLI plumbing, parsers, refactors or config.
- Tests never call live networks; use recorded fixtures.
- Name tests by what they cover: `US1-3: …` for a scenario, `SEC: …` for a security issue.
- Success-criteria measurements (benchmarks, labelled-set evaluation) are not tests: keep them in `tests/perf/` or the eval tooling, run on demand.

## Commits
- Follow [Conventional Commits 1.0.0](https://www.conventionalcommits.org/en/v1.0.0/): `<type>(<scope>): <subject>`.
- Types: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert`.
- Scopes (optional): `ingest`, `scoring`, `db`, `api`, `snapshot`, `sdk`, `wiki`, `specs`.
- Subject: imperative, lowercase, no trailing period, ≤ 72 chars. Body lines ≤ 100 chars.
- Breaking change: `!` before `:` plus a `BREAKING CHANGE: <impact>` footer.
- One coherent change per commit.
- No AI attribution: never add `Co-Authored-By` trailers or "Generated with …" lines to commits or PRs.

## External References
| Need | File |
|------|------|
| Product overview, roadmap | `README.md` |
| Knowledge base index | `docs/wiki/index.md` |
| Wiki conventions | `docs/wiki/SCHEMA.md` |
| Graph ontology | `docs/wiki/graph/ontology.yaml` |

## LLM Wiki
- Project wiki lives at `docs/wiki/`, raw sources at `docs/raw/`.
- Read `docs/wiki/index.md` before answering questions about feeds, licences, providers, scoring or past decisions. Cite with `[[wikilinks]]`.
- If the index is not enough, search with `wiki_search.py` from the `llm-wiki` skill (`--no-embed` for BM25 only).
- Add knowledge via the `llm-wiki` ingest workflow: surgical page edits, update `docs/wiki/index.md`, append to `docs/wiki/log.md`.
- `docs/wiki/SCHEMA.md` is authoritative for page types, tags and frontmatter.
- Never edit `docs/wiki/.wiki-cache/` or generated graph files by hand.
