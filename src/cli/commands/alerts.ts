import { hostname } from "node:os";
import { formatTime, problemLines } from "../../alerts/message";
import { readAlertSettings } from "../../alerts/settings";
import { listProblems } from "../../alerts/store";
import { sendTelegram } from "../../alerts/telegram";
import { openDb } from "../../db/client";
import { EXIT, printJson, printLine, printTable, rejectUnknown, UsageError, warn, type Context } from "../util";

/** Spec 004 FR-014: one test message to the configured chat (contracts/cli.md). */
export async function alertsTest(args: string[], ctx: Context): Promise<number> {
  rejectUnknown(args);
  const settings = await readAlertSettings();
  if (!settings.enabled) {
    warn(`error: ${settings.reason}`);
    return EXIT.usage;
  }
  const result = await sendTelegram(settings, `FoxTrust alerts test from ${hostname()} at ${formatTime(new Date())}`);
  if (!result.ok) {
    warn(`error: ${result.reason}`);
    return EXIT.error;
  }
  if (ctx.json) printJson({ sent: true, chatId: settings.chatId });
  else printLine(`sent to chat ${settings.chatId}`);
  return EXIT.ok;
}

/** Spec 004 FR-014: open problems and problems closed in the last 24 hours. */
export async function alertsList(args: string[], ctx: Context): Promise<number> {
  rejectUnknown(args);
  if (!Bun.env.DATABASE_URL) throw new UsageError("DATABASE_URL is not set");
  const sql = openDb();
  try {
    const rows = await listProblems(sql, new Date());
    if (ctx.json) {
      printJson({
        problems: rows.map((r) => ({
          key: r.key, kind: r.kind, subject: r.subject, state: r.state, openedAt: r.openedAt.toISOString(),
          closedAt: r.closedAt?.toISOString() ?? null, notifiedState: r.notifiedState,
          notifiedAt: r.notifiedAt?.toISOString() ?? null, details: r.details,
        })),
      });
    } else if (rows.length === 0) {
      printLine("No open problems and none closed in the last 24 hours.");
    } else {
      printTable(
        ["problem", "state", "since", "last message", "summary"],
        rows.map((r) => [r.key, r.state, formatTime(r.openedAt), r.notifiedAt ? formatTime(r.notifiedAt) : null, problemLines(r)[0]]),
      );
    }
    return EXIT.ok;
  } finally {
    await sql.close();
  }
}
