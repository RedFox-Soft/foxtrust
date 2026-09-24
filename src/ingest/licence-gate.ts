import { join } from "node:path";

export const DEFAULT_WIKI_ENTITIES = join(import.meta.dir, "..", "..", "docs", "wiki", "entities");

export type LicenceStatus = "shippable" | "local-only" | "missing";
type Term = "yes" | "no" | "unknown";

export type Licence = {
  status: LicenceStatus;
  checked: string | null;
  updateIntervalMinutes: number | null;
  problems: string[];
};

/** "5m" | "30m" | "1h" | "4h" | "1d" → minutes. */
export function parseInterval(value: unknown): number | null {
  const match = typeof value === "string" ? /^(\d+)\s*([mhd])$/.exec(value.trim()) : null;
  if (!match) return null;
  const n = Number(match[1]);
  return n * { m: 1, h: 60, d: 1440 }[match[2] as "m" | "h" | "d"];
}

function parseTerm(value: unknown): Term | null {
  if (value === true || value === "yes") return "yes";
  if (value === false || value === "no") return "no";
  if (value === "unknown") return "unknown";
  return null;
}

function parseCheckedDate(value: unknown): string | null {
  const text = value instanceof Date ? value.toISOString().slice(0, 10) : typeof value === "string" ? value : "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  return Number.isNaN(Date.parse(`${text}T00:00:00Z`)) ? null : text;
}

function frontmatter(text: string): Record<string, unknown> | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!match) return null;
  const parsed = Bun.YAML.parse(match[1]!);
  return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null;
}

/**
 * Reads the licence record for a feed from its wiki entity page
 * (contracts/feed-licence-page.md). Missing or incomplete records block ingestion (FR-014).
 */
export async function readLicence(feedId: string, wikiRoot: string = DEFAULT_WIKI_ENTITIES): Promise<Licence> {
  const missing = (problem: string): Licence => ({
    status: "missing",
    checked: null,
    updateIntervalMinutes: null,
    problems: [problem],
  });

  const file = Bun.file(join(wikiRoot, `${feedId}.md`));
  if (!(await file.exists())) return missing(`no licence page ${feedId}.md in ${wikiRoot}`);

  let fm: Record<string, unknown> | null;
  try {
    fm = frontmatter(await file.text());
  } catch (error) {
    return missing(`licence page frontmatter is not valid YAML: ${(error as Error).message}`);
  }
  if (!fm) return missing("licence page has no YAML frontmatter");

  const problems: string[] = [];
  const commercial = parseTerm(fm.commercial_use);
  const redistribution = parseTerm(fm.redistribution);
  const checked = parseCheckedDate(fm.license_checked);
  const interval = parseInterval(fm.update_interval);
  if (commercial === null) problems.push("commercial_use must be yes, no or unknown");
  if (redistribution === null) problems.push("redistribution must be yes, no or unknown");
  if (typeof fm.url !== "string" || fm.url.trim() === "") problems.push("url is missing");
  if (checked === null) problems.push("license_checked must be a YYYY-MM-DD date");
  if (fm.update_interval !== undefined && interval === null) problems.push("update_interval must look like 30m, 1h or 1d");

  if (problems.length > 0) return { status: "missing", checked, updateIntervalMinutes: interval, problems };
  const status: LicenceStatus = commercial === "yes" && redistribution === "yes" ? "shippable" : "local-only";
  return { status, checked, updateIntervalMinutes: interval, problems };
}
