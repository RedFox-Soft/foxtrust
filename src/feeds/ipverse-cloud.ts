import { parseCloudAsnList } from "./cloud-asns";
import { decodeText, FeedParseError, normaliseCidr, type CategoryEntry, type FeedDefinition, type FeedFile } from "./types";

export const CLOUD_FEED_ID = "ipverse-cloud";
const BASE = "https://raw.githubusercontent.com/ipverse/as-ip-blocks/master/as";

const fileName = (asn: number) => `as${asn}.json`;

function prefixesOf(file: FeedFile, asn: number): { prefixes: string[]; invalid: number } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeText(file.body));
  } catch {
    throw new FeedParseError(`${file.name} is not JSON`);
  }
  const record = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null;
  if (record?.asn !== asn) throw new FeedParseError(`${file.name} describes AS${String(record?.asn)}, not AS${asn}`);
  const lists = typeof record.prefixes === "object" && record.prefixes !== null ? (record.prefixes as Record<string, unknown>) : null;
  if (!lists) throw new FeedParseError(`${file.name} has no prefixes`);
  const prefixes: string[] = [];
  let invalid = 0;
  for (const family of ["ipv4", "ipv6"]) {
    const items = lists[family];
    if (items === undefined) continue;
    if (!Array.isArray(items)) throw new FeedParseError(`${file.name}: prefixes.${family} is not a list`);
    for (const item of items) {
      const prefix = typeof item === "string" ? normaliseCidr(item) : null;
      if (prefix === null) invalid++;
      else prefixes.push(prefix);
    }
  }
  return { prefixes, invalid };
}

/**
 * Spec 005 research R2: the `cloud` category from the BGP-announced prefixes (ipverse/as-ip-blocks,
 * CC0) of the public-cloud ASNs in the reviewed list. Built from the list text and never throws:
 * an invalid list gives a definition whose runs fail with the list's problems, so stored data is
 * kept and the feed shows as failing.
 */
export function cloudFeed(listText: string | null, listFile = "config/cloud/asns.csv"): FeedDefinition {
  const list = listText === null ? { included: [], problems: [`${listFile} cannot be read`] } : parseCloudAsnList(listText, listFile);
  const valid = list.problems.length === 0;
  const included = valid ? list.included : [];
  return {
    id: CLOUD_FEED_ID,
    kind: "category",
    codes: ["cloud"],
    schedule: "40 2 * * *",
    timestamps: "run",
    files: included.map((asn) => ({ name: fileName(asn), url: `${BASE}/${asn}/aggregated.json` })),
    parse(files) {
      if (!valid) throw new FeedParseError(list.problems.join("; "));
      const byName = new Map(files.map((f) => [f.name, f]));
      const seen = new Set<string>();
      const entries: CategoryEntry[] = [];
      let invalidLines = 0;
      for (const asn of included) {
        const file = byName.get(fileName(asn));
        if (!file) throw new FeedParseError(`${fileName(asn)} is missing`);
        const { prefixes, invalid } = prefixesOf(file, asn);
        invalidLines += invalid;
        for (const prefix of prefixes) {
          if (seen.has(prefix)) continue;
          seen.add(prefix);
          entries.push({ prefix, code: "cloud" });
        }
      }
      return { entries, invalidLines };
    },
  };
}
