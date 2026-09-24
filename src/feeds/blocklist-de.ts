import { decodeText, parsePrefixList, type FeedDefinition, type ParsedEntry } from "./types";

const BASE = "https://lists.blocklist.de/lists";
const CODE_BY_FILE: Record<string, string> = {
  "ssh.txt": "ssh_bruteforce",
  "bruteforcelogin.txt": "login_bruteforce",
};

/** blocklist.de 48-hour lists (local-only licence). One address per line. */
export const blocklistDe: FeedDefinition = {
  id: "blocklist-de",
  kind: "behavior",
  codes: ["ssh_bruteforce", "login_bruteforce"],
  schedule: "25 * * * *",
  timestamps: "run",
  files: Object.keys(CODE_BY_FILE).map((name) => ({ name, url: `${BASE}/${name}` })),
  parse(files) {
    const entries: ParsedEntry[] = [];
    let invalidLines = 0;
    for (const file of files) {
      const code = CODE_BY_FILE[file.name];
      if (!code) throw new Error(`blocklist-de: unexpected file ${file.name}`);
      const result = parsePrefixList(decodeText(file.body), (prefix) => ({ prefix, code }));
      entries.push(...result.entries);
      invalidLines += result.invalidLines;
    }
    return { entries, invalidLines };
  },
};
