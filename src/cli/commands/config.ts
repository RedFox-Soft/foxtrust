import { openDb } from "../../db/client";
import { activateConfig } from "../../db/versions";
import type { ScoringConfig } from "../../model/types";
import { validateConfig } from "../../scoring/config";
import { EXIT, printJson, printLine, rejectUnknown, UsageError, warn, type Context } from "../util";

/** Extra checks a command can register (e.g. feed registry ↔ sourceConfidence, added with ingestion). */
export const extraConfigChecks: ((config: ScoringConfig) => string[])[] = [];

async function readConfig(args: string[]): Promise<{ file: string; config: ScoringConfig; problems: string[] }> {
  rejectUnknown(args);
  const file = args[0];
  if (!file || args.length > 1) throw new UsageError("expected exactly one config file");
  let raw: unknown;
  try {
    raw = await Bun.file(file).json();
  } catch (error) {
    throw new UsageError(`cannot read ${file}: ${(error as Error).message}`);
  }
  const problems = validateConfig(raw);
  if (problems.length === 0) {
    for (const check of extraConfigChecks) problems.push(...check(raw as ScoringConfig));
  }
  return { file, config: raw as ScoringConfig, problems };
}

function report(file: string, problems: string[], ctx: Context): void {
  if (ctx.json) printJson({ file, ok: problems.length === 0, problems });
  else if (problems.length === 0) printLine(`${file}: OK`);
  else for (const p of problems) warn(`${file}: ${p}`);
}

export async function configCheck(args: string[], ctx: Context): Promise<number> {
  const { file, problems } = await readConfig(args);
  report(file, problems, ctx);
  return problems.length === 0 ? EXIT.ok : EXIT.usage;
}

export async function configActivate(args: string[], ctx: Context): Promise<number> {
  const { file, config, problems } = await readConfig(args);
  if (problems.length > 0) {
    report(file, problems, ctx);
    return EXIT.usage;
  }
  const sql = openDb();
  try {
    const version = await activateConfig(sql, config);
    if (ctx.json) printJson({ file, configVersion: config.version, dataVersion: version.label });
    else printLine(`Activated ${config.version}: data version ${version.label}`);
    return EXIT.ok;
  } finally {
    await sql.close();
  }
}
