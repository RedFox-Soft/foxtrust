import type { Change, FeedDetails, JobDetails, ProblemRow, ReleaseDetails } from "./store";

/** Telegram `sendMessage` accepts 4096 characters; cut below that at a line boundary. */
export const MESSAGE_LIMIT = 4000;
const MAX_ITEMS = 5;
const BLOCK_LIMIT = 1500;

export function formatTime(date: Date | string | null): string {
  if (date === null) return "never";
  return `${new Date(date).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

export function formatDuration(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 === 0 ? `${hours} h` : `${hours} h ${minutes % 60} min`;
  const days = Math.floor(hours / 24);
  return hours % 24 === 0 ? `${days} d` : `${days} d ${hours % 24} h`;
}

function formatInterval(minutes: number): string {
  if (minutes % 1440 === 0) return minutes === 1440 ? "day" : `${minutes / 1440} days`;
  if (minutes % 60 === 0) return minutes === 60 ? "hour" : `${minutes / 60} h`;
  return `${minutes} min`;
}

function items(list: string[], more: string): string[] {
  const shown = list.slice(0, MAX_ITEMS).map((x) => `· ${x}`);
  if (list.length > MAX_ITEMS) shown.push(`· … and ${list.length - MAX_ITEMS} more (${more})`);
  return shown;
}

function feedLines(id: string, d: FeedDetails): string[] {
  const lines: string[] = [];
  const since = `successful run since ${formatTime(d.lastSuccessAt)} (expected every ${formatInterval(d.staleAfterMinutes / 2)}).`;
  if (d.heldRun) {
    lines.push(`Feed ${id}: run ${d.heldRun.id} held, ${d.heldRun.entryCount ?? "?"} entries vs ${d.heldRun.previousEntryCount ?? "?"} before.`);
    if (d.stale) lines.push(`No ${since}`);
  } else {
    lines.push(`Feed ${id}: no ${since}`);
  }
  if (d.lastError) lines.push(`Last error: ${d.lastError}`);
  if (d.heldRun) lines.push(`→ foxtrust feeds confirm ${d.heldRun.id}`);
  return lines;
}

function releaseLines(kind: string, d: ReleaseDetails): string[] {
  if (d.status === "rejected") return [`Release ${d.version} (${kind}) rejected:`, ...items(d.problems, "see the scheduler log")];
  return [
    `Release ${d.version} (${kind}) held by the regression gate:`,
    ...items(d.regressions, "see the report"),
    ...(d.reportPath ? [`Report: ${d.reportPath}`] : []),
    `→ foxtrust snapshot publish ${d.version} --release-note "<why>"`,
  ];
}

function jobLines(name: string, d: JobDetails): string[] {
  if (name === "database") {
    return [`Database unreachable: ${d.error}`, "Job errors are not recorded until it is back."];
  }
  return [`Job ${name} failed: ${d.error}`];
}

/** The lines that describe an open problem; the first one is its summary. */
export function problemLines(row: ProblemRow): string[] {
  switch (row.kind) {
    case "feed":
      return feedLines(row.subject, row.details);
    case "release":
      return releaseLines(row.subject, row.details);
    case "job":
      return jobLines(row.subject, row.details);
  }
}

function recoveredSubject(row: ProblemRow): string {
  switch (row.kind) {
    case "feed":
      return `feed ${row.subject} updates again`;
    case "release":
      return `${row.subject} release ${row.details.publishedVersion ?? "?"} published`;
    case "job":
      return row.subject === "database" ? "database reachable again" : `job ${row.subject} completed`;
  }
}

const indent = (lines: string[]) => lines.map((l) => `   ${l}`);

function block(change: Change, now: Date): string {
  const { row } = change;
  const lasted = formatDuration((row.closedAt ?? now).getTime() - row.openedAt.getTime());
  const lines = problemLines(row);
  let out: string[];
  switch (change.type) {
    case "opened":
      out = [`⚠️ ${lines[0]}`, ...indent(lines.slice(1))];
      break;
    case "reminder":
      out = [`⏰ Still open after ${lasted}:`, ...indent(lines)];
      break;
    case "recovered":
      out = [`✅ Resolved after ${lasted}: ${recoveredSubject(row)}`];
      break;
    case "resolved-unseen":
      out = [`☑️ ${lines[0]} — resolved after ${lasted} while alerts were undeliverable`];
      break;
  }
  const text = out.join("\n");
  return text.length > BLOCK_LIMIT ? `${text.slice(0, BLOCK_LIMIT - 1)}…` : text;
}

/** contracts/alert-message.md: one message for every pending change of a tick. */
export function renderMessage(changes: Change[], now: Date): string {
  const attention = changes.filter((c) => c.type === "opened" || c.type === "reminder").length;
  const resolved = changes.length - attention;
  const head = attention > 0
    ? `FoxTrust: ${attention} ${attention === 1 ? "needs" : "need"} attention${resolved > 0 ? `, ${resolved} resolved` : ""}`
    : `FoxTrust: all clear, ${resolved} resolved`;
  // Room for the closing "… more changes" line, so a cut message still fits.
  const reserve = 80;
  let text = `${head}\n`;
  for (let i = 0; i < changes.length; i++) {
    const next = `\n${block(changes[i]!, now)}`;
    if (text.length + next.length > MESSAGE_LIMIT - reserve) {
      text += `\n… ${changes.length - i} more changes: run foxtrust alerts list`;
      break;
    }
    text += next;
  }
  return text;
}
