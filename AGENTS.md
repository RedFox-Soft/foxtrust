# Agent Instructions

FoxTrust / IP Trust: IP reputation service. Overview and roadmap: `README.md`.

## Language
- Write everything in English: code, comments, commit messages, docs, specs, wiki pages.

## Stack
- Runtime and package manager: **Bun** (`bun install`, `bun test`, `bun run`). Do not use npm/yarn/pnpm or Node-only APIs when a Bun API exists.
- HTTP: **Elysia**. Language: **TypeScript** (strict).
- Database: **PostgreSQL**. Store IPs and ranges as `inet`/`cidr` and index them with GiST; do not store IPs as text or integers.
- No `package.json` exists yet. Add commands here once they exist.

## Domain Rules
- Keep network **categories** (hosting, vpn, tor, bogon…) separate from **behavior** signals (bruteforce, spam, scan…). Never collapse them into one flag.
- Behavior signals decay (`halfLifeHours`); categories decay slowly or not at all.
- Risk is noisy-OR: `1 − Π(1 − w·c·decay)`. Every `Verdict` must carry `reasons[]` with `source`, `lastSeen`, `contribution`.
- Block/allow is a **policy** over verdicts, not part of scoring.
- Before adding a feed, record its licence (commercial use, redistribution) in `docs/wiki/entities/`. Unknown licence = do not ship in snapshots.
- Snapshot format is MMDB; it must stay readable by standard MaxMind readers.

## Workflow
- Feature specs: spec-kit skills (`/speckit-specify` → `/speckit-plan` → `/speckit-tasks` → `/speckit-implement`). Output goes to `specs/NNN-name/`.
- Principles: `.specify/memory/constitution.md` (v1.0.0). It overrides this file on conflict; amend via `/speckit-constitution`.

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
