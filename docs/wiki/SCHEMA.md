# Wiki Schema

This file is the configuration for this wiki. It documents the conventions, page types, tag taxonomy, and any workflow customizations. The LLM reads this first when entering the wiki, and its conventions override the defaults documented in the `llm-wiki` skill.

This file is **co-evolved with the user**. When the LLM notices a recurring pattern in your edits or feedback that isn't here, it will propose adding it. When something here stops fitting, prune it.

## Wiki location

- Wiki root: `docs/wiki/`
- Raw sources: `docs/raw/`
- Asset/image storage: `docs/raw/assets/`
- Paths elsewhere in this file written as `wiki/...` mean `docs/wiki/...`.

Domain: **FoxTrust / IP Trust** — IP reputation service (Bun + Elysia + TypeScript + PostgreSQL). The wiki holds research and decisions that the code does not record: feeds and their licences, providers and ranges, signal/scoring design, competitors, ADRs.

## Page types

This wiki uses these page types, each with a dedicated subdirectory:

- `source` (in `wiki/sources/`) — one summary page per ingested source.
- `entity` (in `wiki/entities/`) — pages about specific things: people, papers, products, places, organizations.
- `concept` (in `wiki/concepts/`) — pages about ideas, methods, frameworks, abstractions.
- `synthesis` (in `wiki/synthesis/`) — cross-cutting analyses, comparisons, query answers filed back.

### Entity and concept kinds (`kind:` frontmatter, map to graph node types)

| type | kind | For | Required extra frontmatter |
|------|------|-----|----------------------------|
| entity | `feed` | External data feed (Tor exit list, Spamhaus DROP, abuse.ch Feodo) | `url`, `license`, `commercial_use`, `redistribution`, `update_interval`, `license_checked` |
| entity | `provider` | Network operator: cloud, hosting, VPN, mobile carrier (AWS, Mullvad) | `asns` (list), `ranges_url` if published |
| entity | `component` | FoxTrust module (ingest worker, scorer, MMDB builder, SDK, API, honeypot) | `path` (repo path once it exists) |
| entity | `company` / `product` | Competitors and third-party products (AbuseIPDB, MaxMind, IPinfo) | — |
| concept | `signal` | One signal code (`tor_exit`, `ssh_bruteforce`) | `signal_kind: category\|behavior`, `half_life_hours` or `none` |
| concept | `category` | Network category (`hosting`, `vpn`, `tor`, `residential`, `bogon`) | — |
| synthesis | `decision` | ADR: one decision, its options and consequences | `status: proposed\|accepted\|superseded`, `decided` (date) |

Add additional types here as the wiki evolves.

## Tag taxonomy

Keep this list small. Add a tag here before using it.

- `data` — data sources, ingestion, normalisation.
- `license` — licence / terms-of-use facts that constrain commercial use or redistribution.
- `scoring` — signal weights, decay, noisy-OR, policies, false positives.
- `storage` — PostgreSQL schema, `inet`/`cidr`, GiST indexes, aggregates.
- `distribution` — MMDB snapshots, deltas, signing, SDK, API.
- `first-party` — honeypots and opt-in foxauth telemetry.
- `competitor` — other IP reputation / geo-IP services.
- `open-question` — pages or sections that flag unresolved questions.
- `contested` — pages where sources contradict.

## Page sizing

- Soft cap: 400 lines / ~2,000 words. Consider splitting beyond this.
- Hard cap: 800 lines. Must split.

## Frontmatter requirements

Every page must have:
- `type`
- `title`
- `tags`
- `created`
- `updated`

Plus type-specific:
- `source` pages: `authors`, `url` (if applicable), `raw`, `ingested`
- Non-source pages: `sources` listing the source-summary pages drawn from

## Optional graph metadata

Pages may declare typed graph metadata under a top-level `graph:` key. This is the source of truth for the compiled knowledge graph under `wiki/graph/`. Markdown remains canonical; the graph is a regenerable index. Pages without `graph:` still appear as nodes (derived from `type`/`kind`) and still contribute `mentions` edges from body `[[wikilinks]]`.

```yaml
graph:
  node_id: person:praney-behl       # optional; default <node_type>:<slug>
  node_type: person                  # optional; default mapped from type/kind via ontology
  canonical: true                    # mark as canonical when multiple slugs alias the same entity
  aliases: [Praney, praney@example.com]
  relationships:
    - predicate: founded
      object: company:seedblocks
      source: praney-founder-context-dump   # source-page slug
      evidence: "Solo technical founder and sole director..."
      confidence: high               # high | medium | low
      status: current                # current | historical | proposed | disputed | superseded
      # optional:
      # valid_from: 2025-01-15
      # valid_to: 2026-03-01
      # notes: "..."
      # raw_ref: "raw/founder-dump.md#L42"
      # contradicts: edge-id-or-source-slug
      # supersedes: edge-id-or-source-slug
```

Required fields on every relationship: `predicate`, `object`, `source`, `evidence`, `confidence`, `status`. Predicates and the subject/object types they accept are declared in `wiki/graph/ontology.yaml`. Typed semantic edges must be supported by an explicit source — never emit one inferred from training data alone.

## Index structure

(Update this section when sharding.)

Currently flat: a single `wiki/index.md` listing all pages.

When the wiki passes ~150 pages or `index.md` exceeds 300 lines, shard into `wiki/indexes/<type>.md` and update this section.

## Retrieval

- Search is section-level hybrid by default: `uv run --script skills/llm-wiki/scripts/wiki_search.py "query" --json`.
- Semantic backend: local FastEmbed + sqlite-vec (`BAAI/bge-small-en-v1.5`, 384 dimensions). No wiki or query text leaves the machine.
- First semantic use downloads model artifacts to `~/.cache/llm-wiki/fastembed/`; set `FASTEMBED_CACHE_PATH` to override the model cache.
- `wiki/.wiki-cache/` holds regenerable retrieval artifacts: `search-index.json` (parse cache) and `embeddings.sqlite` (section metadata + sqlite-vec vectors). Safe to delete; never edit by hand; gitignored.
- The vector index is content-hashed: only new or changed sections are re-embedded, deleted sections are removed, and model/schema changes rebuild it automatically.
- Dependency-free lexical path: `python skills/llm-wiki/scripts/wiki_search.py "query" --no-embed` (direct Python bypasses PEP 723 dependency resolution). A missing or failed local backend also falls back to lexical search without failing the command.

## Graph layer

The wiki has an optional compiled graph layer under `wiki/graph/`:

- `wiki/graph/ontology.yaml` — declares node types and predicates. **Tracked.** Edit this when you introduce new predicates or domain types.
- `wiki/graph/nodes.jsonl`, `wiki/graph/edges.jsonl` — generated. Track in git only if you want graph diffs in PRs.
- `wiki/graph/graph.sqlite` — generated. Gitignored by default.
- `wiki/graph/graph.graphml` — generated. Track only if you want to diff it.

Generation is reproducible from markdown via `scripts/wiki_graph_extract.py`. The graph can be deleted at any time and rebuilt without losing knowledge — markdown is canonical.

## Workflow customizations

- **Feed licences are facts with a date.** Every `feed` page states commercial-use and redistribution terms with a link to the licence text and `license_checked: YYYY-MM-DD`. Unknown = `unknown`, never assumed permissive. Aggregators (FireHOL) inherit the strictest upstream licence.
- **Category vs behaviour.** Keep network facts (`category`) and observed activity (`signal` with `signal_kind: behavior`) on separate pages; never merge them into one score page.
- **Decisions go to ADRs.** When a design choice is made (e.g. PostgreSQL over MongoDB), file a `synthesis` page with `kind: decision` and link it from affected component pages.
- **Code wins over wiki for implemented behaviour.** Once a component exists, the wiki records *why*; the repository records *what*. Link `path:` instead of copying code.

## User preferences

- **Language: English** for all pages, titles, tags and slugs. The embedding model (`bge-small-en-v1.5`) is English-only; non-English sources are summarised in English.

(As the user expresses style preferences — "always include a 'Why this matters' section on concept pages", "never use bullet lists in summaries", "prefer comparative tables for synthesis pages" — capture them here so they persist across sessions.)

## Lint cadence

- Structural lint: after every 5 ingests.
- Semantic lint: weekly or after every 20 ingests.
- Gap-finding: monthly.
- Graph lint + extract: after every ingest that adds typed `graph.relationships`.

Adjust based on the wiki's growth rate.

## Skill evolution

Optional: capture verified task experience with `/wiki:learn` and propose tested procedural improvements with `/wiki:evolve`. Existing pages and workflows do not change. Raw experience JSON lives under the configured raw root's `experiences/` directory and is immutable. Consolidate observations into ordinary source/concept pages with evidence, applicability, model/tool versions and counterexamples. Optional pattern fields are `kind: experience-pattern` and `status: hypothesis|supported|superseded`.

`wiki/.evolution/` holds durable experiment snapshots, evidence, diffs and measured outcomes; it is not a cache. Wiki search, lint, stats and graph extraction exclude it. Keep searchable summaries in normal synthesis pages linked to the source/pattern pages and index. Private records must not be published with shared skills.

Candidate edits remain isolated until reviewed, selected on validation tasks, independently measured on untouched final-test tasks, and explicitly applied within the user's authorization. Failed edits leave the active skill unchanged while their records persist. Do not repeat a rejected proposal without new evidence or changed conditions. Keep factual wiki access during normal work; do not inject experiment history into task execution. Correct unsupported lessons without deleting their raw evidence. Follow the installed skill's `references/evolution-workflow.md` for the runner contract, cost limits and recovery.
