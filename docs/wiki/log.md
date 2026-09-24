# Wiki Log

Append-only chronological record of operations on the wiki. Each entry begins with `## [YYYY-MM-DD] <op> | <description>` so it's parseable with `grep "^## \[" log.md | tail -N`.

Operations:
- `ingest` — a source was processed into the wiki.
- `query` — a question was answered against the wiki (typically only logged when the answer was filed back as synthesis).
- `lint` — a health check was run.
- `schema` — the schema was modified.
- `shard` — an index was sharded.

---

## [2026-09-24] schema | init project wiki at docs/wiki; IP Trust page kinds, tags, feed-licence rule, graph ontology (feed, provider, component, signal, category, decision)

## [2026-09-24] schema | language set to English for all wiki pages

## [2026-09-24] ingest | Feed licence review 2026-09-24 → 1 source page, 8 feed entity pages (stage 1 core feeds)

## [2026-09-24] ingest | Stage 1 design decisions → 4 ADRs (synthesis) and 9 signal-code concept pages from specs/001-core-ip-lookup research
