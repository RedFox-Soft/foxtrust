#!/usr/bin/env bun
import { FEEDS } from "../feeds/registry";
import { checkSources } from "../ingest/schedule";
import { alertsList, alertsTest } from "./commands/alerts";
import { configActivate, configCheck, extraConfigChecks } from "./commands/config";
import { dbMigrate } from "./commands/db";
import { evalCommand } from "./commands/eval";
import { feedsConfirm, feedsStatus } from "./commands/feeds";
import { ingestCommand } from "./commands/ingest";
import { keysAdd, keysGenerate } from "./commands/keys";
import { lookupCommand } from "./commands/lookup";
import { policyCheck } from "./commands/policy";
import { publicationServe } from "./commands/publication";
import { retentionRun } from "./commands/retention";
import { scheduleCommand } from "./commands/schedule";
import { snapshotAt, snapshotBuild, snapshotList, snapshotPublish, snapshotRetention, snapshotVerify } from "./commands/snapshot";
import { verifyServe } from "./commands/verify";
import { EXIT, takeFlag, UsageError, warn, type Command } from "./util";

extraConfigChecks.push((config) => checkSources(FEEDS, config));

/** Command table: "group sub" or single-word commands. */
export const COMMANDS: Record<string, Command> = {
  lookup: lookupCommand,
  ingest: ingestCommand,
  schedule: scheduleCommand,
  eval: evalCommand,
  "feeds status": feedsStatus,
  "feeds confirm": feedsConfirm,
  "retention run": retentionRun,
  "keys generate": keysGenerate,
  "keys add": keysAdd,
  "publication serve": publicationServe,
  "snapshot build": snapshotBuild,
  "snapshot publish": snapshotPublish,
  "snapshot list": snapshotList,
  "snapshot verify": snapshotVerify,
  "snapshot at": snapshotAt,
  "snapshot retention": snapshotRetention,
  "verify serve": verifyServe,
  "policy check": policyCheck,
  "alerts test": alertsTest,
  "alerts list": alertsList,
  "db migrate": dbMigrate,
  "config check": configCheck,
  "config activate": configActivate,
};

const USAGE = `Usage: foxtrust <command> [options] [--json]

Commands:
${Object.keys(COMMANDS)
  .map((c) => `  ${c}`)
  .join("\n")}`;

export async function main(argv: string[]): Promise<number> {
  const args = [...argv];
  const json = takeFlag(args, "--json");
  if (args.length === 0 || args[0] === "--help" || args[0] === "help") {
    process.stdout.write(`${USAGE}\n`);
    return args.length === 0 ? EXIT.usage : EXIT.ok;
  }

  const two = `${args[0]} ${args[1] ?? ""}`;
  const [name, rest] = COMMANDS[two] ? [two, args.slice(2)] : [args[0]!, args.slice(1)];
  const command = COMMANDS[name];
  if (!command) {
    warn(`unknown command: ${args.join(" ")}\n\n${USAGE}`);
    return EXIT.usage;
  }

  try {
    return await command(rest, { json });
  } catch (error) {
    if (error instanceof UsageError) {
      warn(`error: ${error.message}`);
      return EXIT.usage;
    }
    warn(`error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    return EXIT.error;
  }
}

if (import.meta.main) {
  // Output piped into e.g. `head` closes early; that is not an error.
  process.stdout.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EPIPE") process.exit(process.exitCode ?? 0);
  });
  process.exitCode = await main(Bun.argv.slice(2));
}
