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

## [2026-09-30] ingest | Licence re-check (docs/raw/2026-09-30-licence-recheck.md): Spamhaus DROP terms moved, product-credit statement gone, §3.2 name ban; abuse.ch questions go via Spamhaus → spamhaus-drop, feodo-tracker updated

## [2026-09-30] query | Decision: no licence requests to Spamhaus/abuse.ch; behavior feeds stay internal; customer-facing behavior from first-party data → adr-customer-facing-behavior-data (new); spamhaus-drop, feodo-tracker, blocklist-de, adr-stage1-feed-selection updated
