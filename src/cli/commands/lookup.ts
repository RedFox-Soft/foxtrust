import { createIpTrust } from "../../lookup/lookup";
import type { Verdict } from "../../model/types";
import {
  EXIT,
  parseDate,
  printJson,
  printLine,
  printTable,
  rejectUnknown,
  takeOption,
  UsageError,
  warn,
  type Context,
} from "../util";

function printVerdict(v: Verdict): void {
  printLine(`${v.ip}  risk ${v.risk}  ${v.level.toUpperCase()}`);
  printLine(`categories: ${v.categories.length ? v.categories.join(", ") : "-"}`);
  const n = v.network;
  printLine(
    `network:    ${n.prefix ?? "unknown prefix"}  AS${n.asn ?? "?"} ${n.org ?? ""}  ${n.country ?? ""}`.trimEnd(),
  );
  printLine(`data:       ${v.dataVersion} at ${v.evaluatedAt}`);
  if (v.behaviorHistoryIncomplete) printLine("note:       behavior history before this time was deleted by retention");
  printLine();
  if (v.reasons.length === 0) {
    printLine("No signals.");
    return;
  }
  printTable(
    ["code", "source", "prefix", "last seen", "contribution"],
    v.reasons.map((r) => [r.code, r.source + (r.shippable ? "" : " (local-only)"), r.prefix, r.lastSeen, r.contribution]),
  );
}

export async function lookupCommand(args: string[], ctx: Context): Promise<number> {
  const [atText] = takeOption(args, "--at");
  const excludeSources = takeOption(args, "--exclude-source");
  rejectUnknown(args);
  if (args.length !== 1) throw new UsageError("expected exactly one IP address");
  const at = atText === undefined ? undefined : parseDate(atText, "--at");

  const client = createIpTrust();
  try {
    const result = await client.lookup(args[0]!, { ...(at ? { at } : {}), excludeSources });
    if (!result.ok) {
      if (ctx.json) printJson({ error: result.error });
      else warn(`error: ${result.error.message}`);
      return result.error.code === "no_data" ? EXIT.error : EXIT.usage;
    }
    if (ctx.json) printJson(result.verdict);
    else printVerdict(result.verdict);
    return EXIT.ok;
  } finally {
    await client.close();
  }
}
