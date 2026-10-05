import type { SQL } from "bun";
import type { Db } from "../db/client";
import { renderMessage } from "./message";
import { createRedactor, errorText } from "./redact";
import type { EnabledAlertSettings } from "./settings";
import { markNotified, pendingChanges, pruneClosed, syncProblems, type Change, type Derived, type ProblemRow } from "./store";
import { sendTelegram } from "./telegram";

export type DeriveContext = { now: Date; startedAt: Date };
export type Deriver = (tx: SQL, ctx: DeriveContext) => Promise<Derived>;

export type AlertTickDeps = {
  sql: Db;
  settings: EnabledAlertSettings;
  /** When the scheduler started: the base for feeds that have not succeeded since (research R5). */
  startedAt: Date;
  log: (line: string) => void;
  derivers: Deriver[];
  now?: () => Date;
  timeoutMs?: number;
};

const REJECTION_LOG_MS = 3_600_000;

/**
 * Research R1/R2/R7: one reconcile tick. Derive the current problems, store the differences,
 * send every pending change as one message, and mark the rows told only once Telegram accepts
 * it. A tick never throws and never touches the outcome of other jobs.
 */
export function createAlertTick(deps: AlertTickDeps): () => Promise<void> {
  const redact = createRedactor(deps.settings.token);
  const clock = deps.now ?? (() => new Date());
  let running = false;
  let retryAfterUntil = 0;
  let lastRejectionLog = -Infinity;
  // Research R7: the one problem that cannot live in the database.
  let database: { row: ProblemRow; told: boolean } | null = null;

  const send = async (text: string, now: Date, pending: number): Promise<boolean> => {
    if (now.getTime() < retryAfterUntil) return false;
    const result = await sendTelegram(deps.settings, text, deps.timeoutMs === undefined ? {} : { timeoutMs: deps.timeoutMs });
    if (result.ok) return true;
    if (result.retryAfterSeconds) retryAfterUntil = now.getTime() + result.retryAfterSeconds * 1000;
    if (!result.rejected) {
      deps.log(`alerts: delivery failed (${result.reason}); ${pending} changes pending`);
    } else if (now.getTime() - lastRejectionLog >= REJECTION_LOG_MS) {
      lastRejectionLog = now.getTime();
      deps.log(`alerts: Telegram rejected the message (${result.reason}); check the bot token and chat id`);
    }
    return false;
  };

  const databaseRow = (now: Date, error: string): ProblemRow => ({
    key: "job:database", kind: "job", subject: "database", details: { error, failedAt: now.toISOString() },
    state: "open", openedAt: now, changedAt: now, closedAt: null, notifiedState: "none", notifiedAt: null,
  });

  const tick = async (): Promise<void> => {
    const now = clock();
    let changes: Change[];
    try {
      await deps.sql.begin(async (tx) => {
        for (const derive of deps.derivers) await syncProblems(tx, await derive(tx, { now, startedAt: deps.startedAt }), now);
      });
      await pruneClosed(deps.sql, now);
      changes = await pendingChanges(deps.sql, now);
    } catch (error) {
      database ??= { row: databaseRow(now, errorText(error, redact)), told: false };
      if (!database.told) {
        database.told = await send(renderMessage([{ type: "opened", row: database.row }], now), now, 1);
      }
      return;
    }

    const extra: Change[] = [];
    if (database) {
      const closed: ProblemRow = { ...database.row, state: "closed", closedAt: now, changedAt: now };
      extra.push({ type: database.told ? "recovered" : "resolved-unseen", row: closed });
    }
    const all = [...extra, ...changes];
    if (all.length === 0) return;
    if (!(await send(renderMessage(all, now), now, all.length))) return;
    database = null;
    await markNotified(deps.sql, changes, now);
  };

  return async () => {
    if (running) return;
    running = true;
    try {
      await tick();
    } catch (error) {
      deps.log(`alerts: tick failed (${errorText(error, redact)})`);
    } finally {
      running = false;
    }
  };
}
