# Wiki Index

The catalog of all pages in this wiki. Each entry: a wikilink to the page and a one-line summary. The LLM reads this first when answering queries to identify candidate pages.

Keep summaries tight — one line each. The index is engineered to be cheap to read; a fat index defeats its purpose.

When this file exceeds ~300 lines or the wiki passes ~150 pages, shard into `wiki/indexes/<type>.md` and replace this file with a directory of shards. See the `scaling-playbook.md` reference in the `llm-wiki` skill for the migration procedure.

---

## Sources

- [[2026-09-24-feed-licence-review]] — licence check of ~25 IP feeds; network/hosting/Tor shippable, behavior data mostly local-only

## Entities

- [[iptoasn]] — feed: prefix → ASN, org, registration country; PDDL, shippable
- [[x4bnet-datacenter]] — feed: hosting/datacenter CIDRs; MIT (keep notice), shippable
- [[tor-exit]] — feed: Tor CollecTor exit lists with timestamps; CC0, shippable
- [[cymru-fullbogons]] — feed: unallocated/reserved space; no licence, local-only
- [[spamhaus-drop]] — feed: hijacked netblocks; attribution, revocable, redistribution unknown → local-only
- [[feodo-tracker]] — feed: botnet C2; CC0 vs 2025 terms contested → local-only
- [[blocklist-de]] — feed: SSH/login brute force, 48 h lists; no licence, local-only
- [[iana-special-purpose]] — built-in special-purpose/bogon ranges; CC0, shippable

## Concepts

(populated as concept pages are created)

## Synthesis

(populated as query answers are filed back)
