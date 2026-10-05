import { parseCsv } from "./csv";

export type CloudAsnEntry = {
  asn: number;
  provider: string;
  status: "include" | "exclude";
  source: string;
  added: string;
  reason: string;
  line: number;
};

export type CloudAsnList = { entries: CloudAsnEntry[]; included: number[]; problems: string[] };

const HEADER = "asn,provider,status,source,added,reason";
const MAX_ASN = 4_294_967_295;

/**
 * Spec 005 contracts/cloud-asn-list.md: the reviewed list of public-cloud ASNs. One record per
 * line (no multi-line fields), `#` lines are comments. Never throws: every problem is reported
 * with its line number, and a list with problems must not be used.
 */
export function parseCloudAsnList(text: string, file = "config/cloud/asns.csv"): CloudAsnList {
  const problems: string[] = [];
  const entries: CloudAsnEntry[] = [];
  const at = (line: number, problem: string) => problems.push(`${file} line ${line}: ${problem}`);
  const lines = text.split(/\r?\n/).map((raw, i) => ({ raw, line: i + 1 })).filter((l) => l.raw.trim() !== "" && !l.raw.trimStart().startsWith("#"));

  const header = lines.shift();
  if (!header || header.raw.trim() !== HEADER) {
    at(header?.line ?? 1, `header must be ${HEADER}`);
    return { entries, included: [], problems };
  }

  const seen = new Map<number, number>();
  for (const { raw, line } of lines) {
    const fields = (parseCsv(raw)[0] ?? []).map((f) => f.trim());
    const [asnText = "", provider = "", status = "", source = "", added = "", reason = ""] = fields;
    const before = problems.length;
    const asn = /^\d+$/.test(asnText) ? Number(asnText) : NaN;
    if (!Number.isInteger(asn) || asn < 1 || asn > MAX_ASN) at(line, `asn "${asnText}" is not a valid AS number`);
    else if (seen.has(asn)) at(line, `asn ${asn} is listed twice (lines ${seen.get(asn)} and ${line})`);
    if (provider === "") at(line, "provider is missing");
    if (status !== "include" && status !== "exclude") at(line, "status must be include or exclude");
    if (!/^https:\/\/\S+$/.test(source)) at(line, "source must be an https URL");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(added) || Number.isNaN(Date.parse(`${added}T00:00:00Z`))) at(line, "added must be a YYYY-MM-DD date");
    if (status === "exclude" && reason === "") at(line, "an excluded ASN needs a reason");
    if (Number.isInteger(asn) && !seen.has(asn)) seen.set(asn, line);
    if (problems.length === before) {
      entries.push({ asn, provider, status: status as CloudAsnEntry["status"], source, added, reason, line });
    }
  }

  const included = entries.filter((e) => e.status === "include").map((e) => e.asn).sort((a, b) => a - b);
  if (problems.length === 0 && included.length === 0) at(header.line, "the list includes no ASN");
  return { entries, included, problems };
}
