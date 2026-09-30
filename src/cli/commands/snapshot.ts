import { mkdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { openDb } from "../../db/client";
import { openMmdb } from "../../mmdb/reader";
import { runSnapshotRetention, snapshotAt as findSnapshotAt } from "../../snapshot/archive";
import { buildDelta, buildFull, validateBuild } from "../../snapshot/build";
import {
  buildAndRelease, currentFull, publicationDir, publishStaged, releaseOptionsFromEnv, stagedRangeTable, withSnapshotLock,
  workDir, type ReleaseResult,
} from "../../snapshot/publish";
import { importTrustedKeys, loadSigningKey, sign, verify } from "../../snapshot/sign";
import { EXIT, parseDate, printJson, printLine, printTable, rejectUnknown, takeFlag, takeOption, UsageError, warn, type Context } from "../util";

function printResult(r: ReleaseResult, ctx: Context): number {
  if (ctx.json) printJson(r);
  else {
    printLine(`${r.version} (${r.kind}): ${r.status}${r.path ? ` → ${r.path}` : ""}`);
    if (r.reportPath) printLine(`Report: ${r.reportPath}`);
    for (const p of r.problems) warn(`  ${p}`);
  }
  return r.status === "published" ? EXIT.ok : EXIT.problems;
}

/**
 * `snapshot build --full|--delta [--at <iso>] [--out <dir>]`: builds, validates and publishes.
 * With `--out`, the files go to that directory only: no release row, no publication.
 */
export async function snapshotBuild(args: string[], ctx: Context): Promise<number> {
  const full = takeFlag(args, "--full");
  const delta = takeFlag(args, "--delta");
  const [atText] = takeOption(args, "--at");
  const [out] = takeOption(args, "--out");
  rejectUnknown(args);
  if (args.length > 0) throw new UsageError(`unexpected argument ${args[0]}`);
  if (full === delta) throw new UsageError("pass exactly one of --full or --delta");
  const at = atText ? parseDate(atText, "--at") : new Date();
  const kind = full ? "full" : "delta";

  const sql = openDb();
  try {
    if (out) return await buildToDirectory(sql, kind, at, out, ctx);
    const opts = await releaseOptionsFromEnv();
    const result = await withSnapshotLock(sql, () => buildAndRelease(sql, kind, { ...opts, at }));
    if (result === null) {
      warn("error: another snapshot build is running");
      return EXIT.error;
    }
    if (result.status === "skipped") {
      if (ctx.json) printJson(result);
      else printLine(`${kind}: skipped (${result.reason})`);
      return EXIT.ok;
    }
    return printResult(result, ctx);
  } finally {
    await sql.close();
  }
}

async function buildToDirectory(sql: ReturnType<typeof openDb>, kind: "full" | "delta", at: Date, out: string, ctx: Context): Promise<number> {
  const disputeUrl = Bun.env.FOXTRUST_DISPUTE_URL?.trim() || null;
  let build;
  let baseBytes: Uint8Array | undefined;
  if (kind === "full") build = await buildFull(sql, { at, disputeUrl });
  else {
    const base = await currentFull(sql);
    if (!base) throw new UsageError("a delta needs a published full snapshot as its base");
    const baseTable = await stagedRangeTable(workDir(), base.version);
    if (!baseTable) throw new UsageError(`the range table of ${base.version} is not in ${workDir()}`);
    baseBytes = new Uint8Array(await Bun.file(join(publicationDir(), base.filePath)).arrayBuffer());
    build = await buildDelta(sql, { at, base: base.version, baseTable, disputeUrl });
  }
  const problems = await validateBuild(sql, build, { baseBytes });
  await mkdir(out, { recursive: true });
  const file = join(out, `${build.version}.mmdb`);
  await Bun.write(file, build.bytes);
  await Bun.write(join(out, `${build.version}.ranges.gz`), build.rangeTable);
  if (Bun.env.FOXTRUST_SIGNING_KEY) await Bun.write(`${file}.sig`, await sign(build.bytes, await loadSigningKey(Bun.env.FOXTRUST_SIGNING_KEY)));
  const summary = {
    version: build.version, kind: build.kind, base: build.base, file, size: build.bytes.length,
    records: build.recordCount, ranges: build.rangeCount, sources: build.sources, problems,
  };
  if (ctx.json) printJson(summary);
  else {
    printLine(`${build.version} (${build.kind}) → ${file}: ${build.bytes.length} bytes, ${build.recordCount} records, ${build.rangeCount} ranges`);
    for (const p of problems) warn(`  ${p}`);
  }
  return problems.length === 0 ? EXIT.ok : EXIT.problems;
}

/** `snapshot publish <version> [--release-note "<why>"]`: publishes a validated or held build. */
export async function snapshotPublish(args: string[], ctx: Context): Promise<number> {
  const [releaseNote] = takeOption(args, "--release-note");
  rejectUnknown(args);
  const version = args[0];
  if (!version || args.length > 1) throw new UsageError("expected exactly one version");
  const sql = openDb();
  try {
    const opts = await releaseOptionsFromEnv();
    let result;
    try {
      result = await withSnapshotLock(sql, () => publishStaged(sql, version, { ...opts, releaseNote: releaseNote ?? null }));
    } catch (error) {
      warn(`error: ${(error as Error).message}`);
      return EXIT.error;
    }
    if (result === null) {
      warn("error: another snapshot build is running");
      return EXIT.error;
    }
    return printResult(result, ctx);
  } finally {
    await sql.close();
  }
}

/** `snapshot list`: the release rows, newest first. */
export async function snapshotList(args: string[], ctx: Context): Promise<number> {
  rejectUnknown(args);
  const sql = openDb();
  try {
    const rows = await sql`
      SELECT version, kind, base_version, status, built_at, valid_from, valid_to, size_bytes, record_count,
             signing_key_id, report_path, release_note, error
      FROM snapshot_release ORDER BY built_at DESC, id DESC LIMIT 200`;
    if (ctx.json) {
      printJson(rows.map((r: Record<string, unknown>) => ({ ...r, size_bytes: r.size_bytes === null ? null : Number(r.size_bytes) })));
      return EXIT.ok;
    }
    const iso = (d: Date | null) => (d ? new Date(d).toISOString().slice(0, 16).replace("T", " ") : null);
    printTable(
      ["version", "kind", "base", "status", "built", "valid from", "valid to", "bytes", "records"],
      rows.map((r: Record<string, any>) => [
        r.version, r.kind, r.base_version, r.status, iso(r.built_at), iso(r.valid_from), iso(r.valid_to),
        r.size_bytes === null ? null : Number(r.size_bytes), r.record_count,
      ]),
    );
    return EXIT.ok;
  } finally {
    await sql.close();
  }
}

/** `snapshot verify <file.mmdb> [--key <base64>]…`: checks `<file>.sig` and prints the metadata. */
export async function snapshotVerify(args: string[], ctx: Context): Promise<number> {
  const keys = takeOption(args, "--key");
  rejectUnknown(args);
  const file = args[0];
  if (!file || args.length > 1) throw new UsageError("expected exactly one .mmdb file");
  const trustedText = keys.length > 0 ? keys : (Bun.env.FOXTRUST_TRUSTED_KEYS ?? "").split(",");
  let trusted;
  try {
    trusted = await importTrustedKeys(trustedText);
  } catch (error) {
    throw new UsageError((error as Error).message);
  }
  if (trusted.length === 0) throw new UsageError("no key: pass --key <base64> or set FOXTRUST_TRUSTED_KEYS");
  const bytes = new Uint8Array(await Bun.file(file).arrayBuffer());
  const sigFile = Bun.file(`${file}.sig`);
  if (!(await sigFile.exists())) throw new UsageError(`${basename(file)}.sig not found next to the file`);
  const result = await verify(bytes, new Uint8Array(await sigFile.arrayBuffer()), trusted);
  let metadata: Record<string, unknown> | null = null;
  let readError: string | null = null;
  try {
    metadata = openMmdb(bytes).metadata as unknown as Record<string, unknown>;
  } catch (error) {
    readError = (error as Error).message;
  }
  if (ctx.json) printJson({ file, signature: result.ok ? "valid" : "invalid", keyId: result.keyId, metadata, readError });
  else {
    printLine(`${file}: signature ${result.ok ? `valid (key ${result.keyId})` : "INVALID"}`);
    if (metadata) {
      printLine(`  database_type: ${metadata.database_type}`);
      printLine(`  build_epoch:   ${new Date(Number(metadata.build_epoch) * 1000).toISOString()}`);
      printLine(`  node_count:    ${metadata.node_count}`);
      printLine(`  description:   ${(metadata.description as Record<string, string>)?.en ?? ""}`);
    }
    if (readError) warn(`  cannot read the file: ${readError}`);
  }
  return result.ok && !readError ? EXIT.ok : EXIT.error;
}

/** `snapshot at <iso>`: the archived full snapshot and delta that were current at that time (US4-1). */
export async function snapshotAt(args: string[], ctx: Context): Promise<number> {
  rejectUnknown(args);
  if (args.length !== 1) throw new UsageError("expected exactly one ISO-8601 time");
  const time = parseDate(args[0]!, "time");
  const sql = openDb();
  try {
    const found = await findSnapshotAt(sql, time);
    if (!found) {
      warn(`no published snapshot was current at ${time.toISOString()}`);
      return EXIT.problems;
    }
    const dir = publicationDir();
    if (ctx.json) printJson({ at: time.toISOString(), publicationDir: dir, ...found });
    else {
      for (const f of [found.full, found.delta].filter((x) => x !== null)) {
        printLine(`${f.version} (${f.kind}${f.base ? ` over ${f.base}` : ""}): ${join(dir, f.path)}`);
        printLine(`  signature ${f.signaturePath} (key ${f.signingKeyId}), sha256 ${f.sha256}`);
        printLine(`  current ${f.validFrom} → ${f.validTo ?? "now"}; algorithm ${f.algorithm}, config ${f.config.version} (${f.configSha256.slice(0, 12)}…)`);
      }
    }
    return EXIT.ok;
  } finally {
    await sql.close();
  }
}

/** `snapshot retention run [--now <iso>]`: deletes archive files and rows older than 395 days (US4-3). */
export async function snapshotRetention(args: string[], ctx: Context): Promise<number> {
  if (args[0] !== "run") throw new UsageError("usage: snapshot retention run [--now <iso>]");
  args.shift();
  const [nowText] = takeOption(args, "--now");
  rejectUnknown(args);
  const now = nowText ? parseDate(nowText, "--now") : new Date();
  const sql = openDb();
  try {
    const opts = await releaseOptionsFromEnv();
    const result = await withSnapshotLock(sql, () => runSnapshotRetention(sql, opts, now));
    if (result === null) {
      warn("error: another snapshot build is running");
      return EXIT.error;
    }
    if (ctx.json) printJson(result);
    else printLine(`Deleted ${result.deleted.length} release(s)${result.deleted.length ? ` (${result.deleted.join(", ")})` : ""}; ${result.kept} kept.`);
    return EXIT.ok;
  } finally {
    await sql.close();
  }
}
