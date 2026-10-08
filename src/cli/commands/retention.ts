import { openDb } from "../../db/client";
import { runRetention } from "../../retention/retention";
import { EXIT, printJson, printLine, rejectUnknown, type Context } from "../util";

export async function retentionRun(args: string[], ctx: Context): Promise<number> {
  rejectUnknown(args);
  const sql = openDb();
  try {
    const report = await runRetention(sql);
    if (ctx.json) printJson(report);
    else {
      printLine(`raw observations deleted:  ${report.rawDeleted}`);
      printLine(`long episodes trimmed:     ${report.episodesTrimmed}`);
      printLine(`daily aggregates deleted:  ${report.aggregatesDeleted}`);
      printLine(`artifacts deleted:         ${report.artifactsDeleted}`);
      printLine(`API usage days deleted:    ${report.apiUsageDeleted}`);
      printLine(`admin sessions expired:    ${report.adminSessionsDeleted}`);
      printLine(`admin audit rows deleted:  ${report.adminAuditDeleted}`);
      printLine(`data version:              ${report.dataVersion}`);
    }
    return EXIT.ok;
  } finally {
    await sql.close();
  }
}
