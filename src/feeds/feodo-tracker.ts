import { formatCidr, hostCidr } from "../ip/cidr";
import { toIpValue } from "../ip/parse";
import { decodeText, FeedParseError, type BehaviorEntry, type FeedDefinition } from "./types";

/** "2022-06-04 21:24:53" or "2026-03-07" (UTC) → Date, or null. */
function parseFeodoTime(value: unknown): Date | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  const text = value.trim();
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(text) ? `${text}T00:00:00Z` : `${text.replace(" ", "T")}Z`;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** abuse.ch Feodo Tracker IP blocklist (JSON array). Entries carry their own observation times. */
export const feodoTracker: FeedDefinition = {
  id: "feodo-tracker",
  kind: "behavior",
  codes: ["botnet_c2"],
  schedule: "*/15 * * * *",
  timestamps: "feed",
  files: [{ name: "ipblocklist.json", url: "https://feodotracker.abuse.ch/downloads/ipblocklist.json" }],
  parse(files) {
    let records: unknown;
    try {
      records = JSON.parse(decodeText(files[0]!.body));
    } catch (error) {
      throw new FeedParseError(`not valid JSON: ${(error as Error).message}`);
    }
    if (!Array.isArray(records)) throw new FeedParseError("expected a JSON array");

    const entries: BehaviorEntry[] = [];
    let invalidLines = 0;
    for (const record of records as Record<string, unknown>[]) {
      const ip = toIpValue(typeof record?.ip_address === "string" ? record.ip_address : "");
      const firstSeen = parseFeodoTime(record?.first_seen);
      const lastOnline = parseFeodoTime(record?.last_online);
      const observedAt = lastOnline && firstSeen && lastOnline < firstSeen ? firstSeen : (lastOnline ?? firstSeen);
      if ("error" in ip || observedAt === null) {
        invalidLines++;
        continue;
      }
      entries.push({ prefix: formatCidr(hostCidr(ip)), code: "botnet_c2", observedAt });
    }
    return { entries, invalidLines };
  },
};
