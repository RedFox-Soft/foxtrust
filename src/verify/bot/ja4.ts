import { join } from "node:path";

/**
 * JA4 TLS fingerprints from the operator's proxy (spec 007 research R6). Only JA4 itself is used,
 * never another JA4+ method (FoxIO licence: docs/wiki/synthesis/tls-fingerprints-at-the-proxy.md).
 * A reviewed list maps the first two JA4 parts to a browser family or a tool.
 */

export const JA4_PATTERN = /^[tq]\d{2}[di]\d{4}[a-z0-9]{2}_[0-9a-f]{12}_[0-9a-f]{12}$/;
const JA4_AB = /^[tq]\d{2}[di]\d{4}[a-z0-9]{2}_[0-9a-f]{12}$/;
const FAMILY = /^(chromium|gecko|webkit|tool:[a-z0-9-]{1,32})$/;

export type Ja4Family = "chromium" | "gecko" | "webkit" | `tool:${string}`;
export type Ja4Families = Map<string, Ja4Family>;

export const JA4_FAMILIES_FILE = join(import.meta.dir, "..", "..", "..", "config", "bot", "ja4-families.csv");

export class Ja4FamiliesError extends Error {}

export function parseJa4Families(text: string, file: string): Ja4Families {
  const families: Ja4Families = new Map();
  const problems: string[] = [];
  const lines = text.split("\n");
  if ((lines[0] ?? "").trim() !== "family,ja4_ab,source,added") problems.push(`${file} line 1: header must be family,ja4_ab,source,added`);
  lines.slice(1).forEach((raw, i) => {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) return;
    const at = `${file} line ${i + 2}`;
    const [family = "", ja4ab = "", source = "", added = "", ...rest] = line.split(",");
    if (rest.length > 0) problems.push(`${at}: too many fields`);
    else if (!FAMILY.test(family)) problems.push(`${at}: family must be chromium, gecko, webkit or tool:<name>`);
    else if (!JA4_AB.test(ja4ab)) problems.push(`${at}: ja4_ab must be the first two JA4 parts`);
    else if (source.trim() === "") problems.push(`${at}: source is required`);
    else if (!/^\d{4}-\d{2}-\d{2}$/.test(added)) problems.push(`${at}: added must be a date`);
    else if (families.has(ja4ab)) problems.push(`${at}: duplicate ja4_ab ${ja4ab}`);
    else families.set(ja4ab, family as Ja4Family);
  });
  if (problems.length > 0) throw new Ja4FamiliesError(problems.join("\n"));
  return families;
}

export async function loadJa4Families(file = JA4_FAMILIES_FILE): Promise<Ja4Families> {
  return parseJa4Families(await Bun.file(file).text(), file);
}

/** The family of a JA4 value, or null when it is malformed or not in the list. */
export function classifyJa4(value: string | null, families: Ja4Families): Ja4Family | null {
  if (!value || !JA4_PATTERN.test(value)) return null;
  return families.get(value.slice(0, value.lastIndexOf("_"))) ?? null;
}
