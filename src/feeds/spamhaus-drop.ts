import { contentLines, decodeText, normaliseCidr, type BehaviorEntry, type FeedDefinition } from "./types";

const BASE = "https://www.spamhaus.org/drop";

/** Spamhaus DROP / DROPv6: NDJSON `{"cidr", "sblid", "rir"}` plus a trailing metadata line. */
export const spamhausDrop: FeedDefinition = {
  id: "spamhaus-drop",
  kind: "behavior",
  codes: ["hijacked_netblock"],
  schedule: "5 */6 * * *",
  timestamps: "run",
  files: [
    { name: "drop_v4.json", url: `${BASE}/drop_v4.json` },
    { name: "drop_v6.json", url: `${BASE}/drop_v6.json` },
  ],
  parse(files) {
    const entries: BehaviorEntry[] = [];
    let invalidLines = 0;
    for (const file of files) {
      for (const line of contentLines(decodeText(file.body))) {
        let record: { cidr?: unknown; type?: unknown };
        try {
          record = JSON.parse(line);
        } catch {
          invalidLines++;
          continue;
        }
        if (record.type === "metadata") continue;
        const prefix = typeof record.cidr === "string" ? normaliseCidr(record.cidr) : null;
        if (prefix === null) invalidLines++;
        else entries.push({ prefix, code: "hijacked_netblock" });
      }
    }
    return { entries, invalidLines };
  },
};
