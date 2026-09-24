import { decodeText, parsePrefixList, type FeedDefinition, type ParsedEntry } from "./types";

const BASE = "https://team-cymru.org/Services/Bogons";

/** Team Cymru fullbogons (local-only licence). `# last updated …` header, then one CIDR per line. */
export const cymruFullbogons: FeedDefinition = {
  id: "cymru-fullbogons",
  kind: "category",
  codes: ["bogon"],
  schedule: "40 */4 * * *",
  timestamps: "run",
  files: [
    { name: "fullbogons-ipv4.txt", url: `${BASE}/fullbogons-ipv4.txt` },
    { name: "fullbogons-ipv6.txt", url: `${BASE}/fullbogons-ipv6.txt` },
  ],
  parse(files) {
    const entries: ParsedEntry[] = [];
    let invalidLines = 0;
    for (const file of files) {
      const result = parsePrefixList(decodeText(file.body), (prefix) => ({ prefix, code: "bogon" }));
      entries.push(...result.entries);
      invalidLines += result.invalidLines;
    }
    return { entries, invalidLines };
  },
};
