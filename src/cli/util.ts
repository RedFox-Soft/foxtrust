/** Exit codes from contracts/cli.md. */
export const EXIT = { ok: 0, error: 1, usage: 2, problems: 3 } as const;

/** Invalid arguments or input: exit code 2. */
export class UsageError extends Error {}

export type Context = { json: boolean };

export type Command = (args: string[], ctx: Context) => Promise<number>;

export function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export function printLine(text = ""): void {
  process.stdout.write(`${text}\n`);
}

export function warn(text: string): void {
  process.stderr.write(`${text}\n`);
}

/** Left-aligned plain-text table. */
export function printTable(headers: string[], rows: (string | number | null | undefined)[][]): void {
  const cells = rows.map((r) => r.map((c) => (c === null || c === undefined ? "-" : String(c))));
  const widths = headers.map((h, i) => Math.max(h.length, ...cells.map((r) => (r[i] ?? "").length)));
  const line = (r: string[]) => r.map((c, i) => c.padEnd(widths[i]!)).join("  ").trimEnd();
  printLine(line(headers));
  printLine(line(widths.map((w) => "-".repeat(w))));
  for (const r of cells) printLine(line(r));
}

/** Takes the value of `--name <value>` (repeatable) out of `args`. */
export function takeOption(args: string[], name: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < args.length; ) {
    if (args[i] === name) {
      const value = args[i + 1];
      if (value === undefined || value.startsWith("--")) throw new UsageError(`${name} needs a value`);
      values.push(value);
      args.splice(i, 2);
    } else {
      i++;
    }
  }
  return values;
}

export function takeFlag(args: string[], name: string): boolean {
  const index = args.indexOf(name);
  if (index === -1) return false;
  args.splice(index, 1);
  return true;
}

export function parseDate(text: string, name: string): Date {
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) throw new UsageError(`${name} must be an ISO-8601 date-time`);
  return date;
}

export function rejectUnknown(args: string[]): void {
  const unknown = args.find((a) => a.startsWith("--"));
  if (unknown) throw new UsageError(`unknown option ${unknown}`);
}
