import { formatCidr, hostCidr } from "../ip/cidr";
import { toIpValue } from "../ip/parse";
import { decodeText, FeedParseError, type CategoryEntry, type FeedDefinition } from "./types";

const INDEX = "https://collector.torproject.org/recent/exit-lists/";
const FILE_NAME = /^\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}$/;
const KEYWORDS = new Set(["@type", "ExitNode", "Published", "LastStatus", "ExitAddress"]);

/** Newest exit-list file name in a CollecTor directory listing, or null. */
export function newestExitList(indexHtml: string): string | null {
  const names = [...indexHtml.matchAll(/href="([^"/]+)"/g)].map((m) => m[1]!).filter((n) => FILE_NAME.test(n));
  return names.sort().at(-1) ?? null;
}

/** Tor Project CollecTor exit lists (CC0), `tordnsel` format. */
export const torExit: FeedDefinition = {
  id: "tor-exit",
  kind: "category",
  codes: ["tor_exit"],
  schedule: "10 * * * *",
  timestamps: "run",
  files: [{ name: "exit-list.txt", url: INDEX }],
  async resolveFiles(fetchText) {
    const newest = newestExitList(await fetchText(INDEX));
    if (newest === null) throw new FeedParseError("no exit-list file in the CollecTor directory listing");
    return [{ name: "exit-list.txt", url: `${INDEX}${newest}` }];
  },
  parse(files) {
    const seen = new Set<string>();
    const entries: CategoryEntry[] = [];
    const lines = decodeText(files[0]!.body).split(/\r?\n/);
    lines.forEach((raw, index) => {
      const line = raw.trim();
      if (line === "") return;
      const [keyword, ...fields] = line.split(/\s+/);
      if (!KEYWORDS.has(keyword!)) throw new FeedParseError(`line ${index + 1}: unexpected keyword "${keyword}"`);
      if (keyword !== "ExitAddress") return;
      const ip = toIpValue(fields[0] ?? "");
      const stamp = `${fields[1] ?? ""}T${fields[2] ?? ""}Z`;
      if ("error" in ip || fields.length !== 3 || Number.isNaN(Date.parse(stamp))) {
        throw new FeedParseError(`line ${index + 1}: malformed ExitAddress record`);
      }
      const prefix = formatCidr(hostCidr(ip));
      if (!seen.has(prefix)) {
        seen.add(prefix);
        entries.push({ prefix, code: "tor_exit" });
      }
    });
    if (!lines[0]?.startsWith("@type tordnsel")) throw new FeedParseError("missing @type tordnsel header");
    return { entries, invalidLines: 0 };
  },
};
