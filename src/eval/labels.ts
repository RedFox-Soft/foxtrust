import { join } from "node:path";
import { FEEDS } from "../feeds/registry";
import { parseIp } from "../ip/parse";

export const DEFAULT_LABELS = join(import.meta.dir, "..", "..", "data", "labelled", "seed.csv");
export const MIN_PER_LABEL = 100;

export type LabelledAddress = {
  ip: string;
  label: "good" | "bad";
  reason: string;
  labelSource: string;
  added: string;
};

/** Minimal CSV: comma-separated, double quotes around fields that contain commas or quotes. */
function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      out.push(field);
      field = "";
    } else field += ch;
  }
  out.push(field);
  return out;
}

export class LabelError extends Error {
  constructor(readonly problems: string[]) {
    super(`invalid labelled set:\n- ${problems.join("\n- ")}`);
  }
}

/** Parses and validates a labelled set (data-model.md "Labelled address", FR-024). */
export function parseLabels(csv: string, opts: { minPerLabel?: number } = {}): LabelledAddress[] {
  const problems: string[] = [];
  const lines = csv.split(/\r?\n/).filter((l) => l.trim() !== "");
  const header = lines.shift();
  if (header?.trim() !== "ip,label,reason,label_source,added") {
    throw new LabelError(['header must be "ip,label,reason,label_source,added"']);
  }
  const feeds = new Set(FEEDS.map((f) => f.id));
  const seen = new Set<string>();
  const out: LabelledAddress[] = [];

  lines.forEach((line, index) => {
    const where = `line ${index + 2}`;
    const [ip = "", label = "", reason = "", labelSource = "", added = ""] = parseCsvLine(line);
    const parsed = parseIp(ip);
    if (!parsed.ok) problems.push(`${where}: invalid ip ${JSON.stringify(ip)}`);
    else if (parsed.ip !== ip) problems.push(`${where}: ip ${ip} is not canonical (use ${parsed.ip})`);
    if (seen.has(ip)) problems.push(`${where}: duplicate ip ${ip}`);
    seen.add(ip);
    if (label !== "good" && label !== "bad") problems.push(`${where}: label must be good or bad`);
    if (reason.trim() === "") problems.push(`${where}: reason is empty`);
    if (!feeds.has(labelSource) && !/^public:\S+/.test(labelSource)) {
      problems.push(`${where}: label_source must be a feed id or public:<reference>`);
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(added)) problems.push(`${where}: added must be YYYY-MM-DD`);
    out.push({ ip, label: label as "good" | "bad", reason, labelSource, added });
  });

  const min = opts.minPerLabel ?? MIN_PER_LABEL;
  for (const label of ["good", "bad"] as const) {
    const rows = out.filter((r) => r.label === label);
    if (rows.length < min) problems.push(`needs at least ${min} ${label} rows, found ${rows.length}`);
    if (!rows.some((r) => r.ip.includes(":")) || !rows.some((r) => !r.ip.includes(":"))) {
      problems.push(`${label} rows must include both IPv4 and IPv6 addresses`);
    }
  }
  if (problems.length > 0) throw new LabelError(problems);
  return out;
}

export async function loadLabels(path: string = DEFAULT_LABELS): Promise<LabelledAddress[]> {
  return parseLabels(await Bun.file(path).text());
}

/** Feed id the label came from (leave-one-source-out), or null for public references. */
export function feedSourceOf(label: LabelledAddress): string | null {
  return label.labelSource.startsWith("public:") ? null : label.labelSource;
}
