import { feedDeriver, releaseDeriver } from "../alerts/derive";
import { createAlertTick } from "../alerts/reconcile";
import { createRedactor, errorText, type Redact } from "../alerts/redact";
import type { AlertSettings } from "../alerts/settings";
import { closeProblem, openProblem } from "../alerts/store";
import type { Db } from "../db/client";
import type { FeedDefinition } from "../feeds/types";
import { BUILTIN_BOGON_SOURCE } from "../lookup/signals";
import type { ScoringConfig } from "../model/types";
import { runRetention } from "../retention/retention";
import { ARCHIVE_RETENTION_SCHEDULE, runSnapshotRetention } from "../snapshot/archive";
import { buildAndRelease, withSnapshotLock, type ReleaseOptions } from "../snapshot/publish";
import { readLicence, type Licence } from "./licence-gate";
import { runFeed } from "./run";

export const RETENTION_SCHEDULE = "30 3 * * *";
/** Research R10: after the daily hosting refresh at 04:20, and hourly deltas. */
export const FULL_SNAPSHOT_SCHEDULE = "50 4 * * *";
export const DELTA_SNAPSHOT_SCHEDULE = "50 * * * *";
/** Spec 004 research R1: operator-alert reconcile tick. */
export const ALERT_SCHEDULE = "* * * * *";

function expandField(field: string, min: number, max: number): Set<number> {
  const out = new Set<number>();
  for (const part of field.split(",")) {
    const [rangeText, stepText] = part.split("/");
    const step = stepText === undefined ? 1 : Number(stepText);
    let [lo, hi] = [min, max];
    if (rangeText !== "*") {
      const [a, b] = rangeText!.split("-").map(Number);
      lo = a!;
      hi = b ?? (stepText === undefined ? a! : max);
    }
    if (![lo, hi, step].every(Number.isInteger) || step < 1 || lo < min || hi > max || lo > hi) {
      throw new Error(`unsupported cron field "${field}"`);
    }
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

/** Smallest gap (minutes) between two firings of a 5-field cron expression over one week. */
export function minimumGapMinutes(expression: string): number {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error(`cron expression must have 5 fields: "${expression}"`);
  const [minute, hour, dom, month, dow] = fields as [string, string, string, string, string];
  const minutes = expandField(minute, 0, 59);
  const hours = expandField(hour, 0, 23);
  if (dom !== "*" || month !== "*" || dow !== "*") return 24 * 60; // day-level schedules: at most daily here
  const firings: number[] = [];
  for (let day = 0; day < 7; day++) {
    for (const h of hours) for (const m of minutes) firings.push(day * 1440 + h * 60 + m);
  }
  firings.sort((a, b) => a - b);
  let gap = Infinity;
  for (let i = 0; i < firings.length; i++) {
    const next = i + 1 < firings.length ? firings[i + 1]! : firings[0]! + 7 * 1440;
    gap = Math.min(gap, next - firings[i]!);
  }
  return gap;
}

/** FR-016: no feed may be scheduled more often than its publisher's update_interval allows. */
export function checkSchedules(feeds: FeedDefinition[], licences: Map<string, Licence>): string[] {
  const problems: string[] = [];
  for (const def of feeds) {
    const minimum = licences.get(def.id)?.updateIntervalMinutes;
    const gap = minimumGapMinutes(def.schedule);
    if (minimum !== null && minimum !== undefined && gap < minimum) {
      problems.push(`${def.id}: schedule "${def.schedule}" runs every ${gap} min, but update_interval is ${minimum} min`);
    }
  }
  return problems;
}

/** Every registry feed needs a source confidence; the config must not name unknown sources. */
export function checkSources(feeds: FeedDefinition[], config: ScoringConfig): string[] {
  const problems: string[] = [];
  const known = new Set([...feeds.map((f) => f.id), BUILTIN_BOGON_SOURCE]);
  for (const def of feeds) {
    if (config.sourceConfidence[def.id] === undefined) problems.push(`sourceConfidence has no entry for feed ${def.id}`);
    for (const code of def.codes) {
      if (!config.codes[code]) problems.push(`feed ${def.id} produces code ${code}, which is not in codes`);
    }
  }
  for (const source of Object.keys(config.sourceConfidence)) {
    if (!known.has(source)) problems.push(`sourceConfidence names unknown source ${source}`);
  }
  return problems;
}

export async function readLicences(feeds: FeedDefinition[], wikiRoot?: string): Promise<Map<string, Licence>> {
  const out = new Map<string, Licence>();
  for (const def of feeds) out.set(def.id, await readLicence(def.id, wikiRoot));
  return out;
}

export type JobDeps = {
  sql: Db;
  log: (line: string) => void;
  /** Record job problems for operator alerts (only when alerts are enabled). */
  record: boolean;
  redact?: Redact;
  now?: () => Date;
};

/**
 * Runs one scheduled job (spec 004 FR-004). A thrown error is logged as before and, with alerts
 * on, opens the job problem `job:<name>`; a completed run closes it. Recording never changes the
 * job's outcome or log lines (FR-009).
 */
export async function runJob(name: string, label: string, fn: () => Promise<void>, deps: JobDeps): Promise<void> {
  const redact = deps.redact ?? ((text: string) => text);
  const key = `job:${name}`;
  const now = () => deps.now?.() ?? new Date();
  let failure: string | null = null;
  try {
    await fn();
  } catch (error) {
    failure = errorText(error, redact);
    deps.log(`${new Date().toISOString()} ${label}: error ${failure}`);
  }
  if (!deps.record) return;
  try {
    if (failure === null) await closeProblem(deps.sql, key, now());
    else {
      const at = now();
      await openProblem(deps.sql, { kind: "job", key, subject: name, details: { error: failure.slice(0, 1000), failedAt: at.toISOString() } }, at);
    }
  } catch (error) {
    deps.log(`alerts: cannot record job ${name} (${errorText(error, redact)})`);
  }
}

/** The one start line about alerts (contracts/cli.md). */
export function alertsStartLine(settings: AlertSettings): string {
  return settings.enabled ? `alerts: enabled (chat ${settings.chatId})` : `alerts: disabled (${settings.reason})`;
}

/**
 * Registers one Bun.cron job per feed plus nightly retention. Returns a stop function.
 * With `heartbeatPath`, the current time is written there at start and every minute, so a
 * container healthcheck can tell a live scheduler from a hung one. With alert settings, the
 * operator-alert reconcile tick runs every minute (spec 004).
 */
export function startScheduler(
  sql: Db,
  feeds: FeedDefinition[],
  log: (line: string) => void,
  opts: { heartbeatPath?: string; snapshot?: ReleaseOptions; alerts?: AlertSettings } = {},
): () => void {
  const beat = async () => {
    if (opts.heartbeatPath) await Bun.write(opts.heartbeatPath, `${new Date().toISOString()}\n`);
  };
  void beat();
  const alerts = opts.alerts?.enabled ? opts.alerts : null;
  if (opts.alerts) log(alertsStartLine(opts.alerts));
  const deps: JobDeps = { sql, log, record: alerts !== null, ...(alerts ? { redact: createRedactor(alerts.token) } : {}) };
  const stamp = () => new Date().toISOString();

  const jobs = feeds.map((def) =>
    Bun.cron(
      def.schedule,
      () =>
        runJob(`ingest:${def.id}`, def.id, async () => {
          const r = await runFeed(sql, def.id);
          log(`${stamp()} ${def.id}: ${r.status}${r.error ? ` (${r.error})` : ""}`);
        }, deps),
      { tz: "UTC" },
    ),
  );
  jobs.push(
    Bun.cron(
      RETENTION_SCHEDULE,
      () =>
        runJob("retention", "retention", async () => {
          const r = await runRetention(sql);
          log(`${stamp()} retention: ${JSON.stringify(r)}`);
        }, deps),
      { tz: "UTC" },
    ),
  );
  const release = opts.snapshot;
  if (release) {
    for (const [kind, schedule] of [["full", FULL_SNAPSHOT_SCHEDULE], ["delta", DELTA_SNAPSHOT_SCHEDULE]] as const) {
      jobs.push(
        Bun.cron(
          schedule,
          () =>
            runJob(`snapshot-${kind}`, `snapshot ${kind}`, async () => {
              const r = await withSnapshotLock(sql, () => buildAndRelease(sql, kind, release), { wait: kind === "full" });
              if (r === null) log(`${stamp()} snapshot ${kind}: skipped (another build holds the lock)`);
              else if (r.status === "skipped") log(`${stamp()} snapshot ${kind}: skipped (${r.reason})`);
              else log(`${stamp()} snapshot ${r.version}: ${r.status}${r.problems.length ? ` (${r.problems.join("; ")})` : ""}`);
            }, deps),
          { tz: "UTC" },
        ),
      );
    }
    jobs.push(
      Bun.cron(
        ARCHIVE_RETENTION_SCHEDULE,
        () =>
          runJob("snapshot-retention", "snapshot retention", async () => {
            const r = await withSnapshotLock(sql, () => runSnapshotRetention(sql, release));
            log(`${stamp()} snapshot retention: ${r === null ? "skipped (lock held)" : JSON.stringify(r)}`);
          }, deps),
        { tz: "UTC" },
      ),
    );
  }
  if (alerts) {
    const tick = createAlertTick({ sql, settings: alerts, startedAt: new Date(), log, derivers: [feedDeriver(feeds), releaseDeriver] });
    jobs.push(Bun.cron(ALERT_SCHEDULE, tick, { tz: "UTC" }));
  }
  if (opts.heartbeatPath) jobs.push(Bun.cron("* * * * *", beat, { tz: "UTC" }));
  return () => {
    for (const job of jobs) job.stop();
  };
}
