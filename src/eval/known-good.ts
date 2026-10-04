import { join, relative } from "node:path";
import { parseIp } from "../ip/parse";

const REPO_ROOT = join(import.meta.dir, "..", "..");

/** Release-gate configuration: addresses no release may newly rate `medium` or higher (spec 003 FR-001). */
export const DEFAULT_KNOWN_GOOD = join(REPO_ROOT, "config", "accuracy", "known-good.csv");
export const MIN_KNOWN_GOOD = 100;
const HEADER = "ip,reason,source,added";

export type KnownGoodEntry = { ip: string; reason: string; source: string; added: string };

/** Which reference a report used: repo-relative path, file hash and size (contracts/known-good.md). */
export type ReferenceVersion = { file: string; sha256: string; count: number };

export type KnownGood = { entries: KnownGoodEntry[]; reference: ReferenceVersion };

export class KnownGoodError extends Error {
  constructor(
    readonly file: string,
    readonly problems: string[],
  ) {
    super(`invalid known-good reference ${file}:\n- ${problems.join("\n- ")}`);
  }
}

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

const displayPath = (path: string) => {
  const rel = relative(REPO_ROOT, path);
  return (rel.startsWith("..") ? path : rel).replaceAll("\\", "/");
};

/** Parses and validates the reference text; throws KnownGoodError with every problem and its line. */
export function parseKnownGood(csv: string, file: string, opts: { min?: number } = {}): KnownGoodEntry[] {
  const problems: string[] = [];
  const lines = csv.split(/\r?\n/);
  if (lines[0]?.trim() !== HEADER) throw new KnownGoodError(file, [`line 1: header must be "${HEADER}"`]);
  const seen = new Set<string>();
  const out: KnownGoodEntry[] = [];

  lines.forEach((line, index) => {
    if (index === 0 || line.trim() === "") return;
    const where = `line ${index + 1}`;
    const [ip = "", reason = "", source = "", added = ""] = parseCsvLine(line);
    const parsed = parseIp(ip);
    if (!parsed.ok) problems.push(`${where}: invalid ip ${JSON.stringify(ip)}`);
    else if (parsed.ip !== ip) problems.push(`${where}: ip ${ip} is not canonical (use ${parsed.ip})`);
    if (seen.has(ip)) problems.push(`${where}: duplicate ip ${ip}`);
    seen.add(ip);
    if (reason.trim() === "") problems.push(`${where}: reason is empty`);
    if (!/^public:\S+$/.test(source)) problems.push(`${where}: source must be public:<reference>, got ${JSON.stringify(source)}`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(added) || Number.isNaN(Date.parse(added))) problems.push(`${where}: added must be YYYY-MM-DD`);
    out.push({ ip, reason, source, added });
  });

  const min = opts.min ?? MIN_KNOWN_GOOD;
  if (out.length < min) problems.push(`needs at least ${min} rows, found ${out.length}`);
  if (!out.some((r) => r.ip.includes(":")) || !out.some((r) => !r.ip.includes(":"))) {
    problems.push("rows must include both IPv4 and IPv6 addresses");
  }
  if (problems.length > 0) throw new KnownGoodError(file, problems);
  return out;
}

/** Loads the reference and its version (file, sha256 of the bytes, row count). */
export async function loadKnownGood(path: string = DEFAULT_KNOWN_GOOD): Promise<KnownGood> {
  const file = displayPath(path);
  const handle = Bun.file(path);
  if (!(await handle.exists())) throw new KnownGoodError(file, ["file does not exist"]);
  const bytes = new Uint8Array(await handle.arrayBuffer());
  const entries = parseKnownGood(new TextDecoder().decode(bytes), file);
  const sha256 = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  return { entries, reference: { file, sha256, count: entries.length } };
}
