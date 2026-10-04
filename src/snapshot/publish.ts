import type { SQL } from "bun";
import { mkdir, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Db } from "../db/client";
import type { ResolvedVersion } from "../db/versions";
import { DEFAULT_WIKI_ENTITIES, readLicence } from "../ingest/licence-gate";
import type { ScoringConfig } from "../model/types";
import { configSha256 } from "../scoring/config";
import { buildDelta, buildFull, deltaVersion, fullVersion, validateBuild, type Build } from "./build";
import { DEFAULT_KNOWN_GOOD, loadKnownGood } from "../eval/known-good";
import { releaseReport, type ReleaseReport } from "./report";
import { loadSigningKey, readKeysFile, sign, writeKeysFile, type PublicKeyInfo, type SigningKey } from "./sign";

/**
 * Release pipeline (research R10): stage → validate → report and gate → sign → write files →
 * record the release → rewrite the manifest and archive index. Every public file is written to a
 * temporary name and renamed, so readers never see a partial file.
 */

export type ReleaseStatus = "published" | "held" | "rejected";


export type ReleaseOptions = {
  /** Publication root: files go to `<dir>/v1/...`. */
  dir: string;
  /** Private work directory: staged builds and their range tables. */
  workDir: string;
  key: SigningKey;
  disputeUrl: string | null;
  now?: Date;
  releaseNote?: string | null;
  wikiRoot?: string;
  sample?: number;
  /** Known-good reference for the release report and gate (default config/accuracy/known-good.csv). */
  knownGoodFile?: string;
};

export type ReleaseResult = {
  version: string;
  kind: "full" | "delta";
  status: ReleaseStatus;
  problems: string[];
  path: string | null;
  reportPath: string | null;
};

export type Notice = { source: string; licence: string; notice: string };

export const publicationDir = () => Bun.env.FOXTRUST_PUBLICATION_DIR ?? "var/publication";
export const workDir = () => Bun.env.FOXTRUST_SNAPSHOT_WORK_DIR ?? "var/snapshots";

const kindDir = (kind: "full" | "delta") => (kind === "full" ? "full" : "delta");
export const publicPath = (kind: "full" | "delta", version: string) => `v1/${kindDir(kind)}/${version}.mmdb`;

export async function writeAtomic(path: string, bytes: Uint8Array | string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${crypto.randomUUID().slice(0, 8)}`;
  try {
    await Bun.write(tmp, bytes);
    await rename(tmp, path);
  } catch (error) {
    await rm(tmp, { force: true });
    throw error;
  }
}

const sha256 = (bytes: Uint8Array) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

// ---- staging ---------------------------------------------------------------------------------

type StagedMeta = Omit<Build, "bytes" | "rangeTable" | "builtAt" | "dataVersion"> & { builtAt: string; dataVersionId: number };

/** Keeps the build and its range table privately, for `snapshot publish` of held builds and for deltas. */
export async function stage(build: Build, dir: string): Promise<void> {
  const { bytes, rangeTable, dataVersion, builtAt, ...rest } = build;
  await writeAtomic(join(dir, `${build.version}.mmdb`), bytes);
  await writeAtomic(join(dir, `${build.version}.ranges.gz`), rangeTable);
  const meta: StagedMeta = { ...rest, builtAt: builtAt.toISOString(), dataVersionId: dataVersion.id };
  await writeAtomic(join(dir, `${build.version}.json`), json(meta));
}

async function dataVersionById(sql: SQL, id: number): Promise<ResolvedVersion> {
  const [row] = await sql`
    SELECT dv.id, dv.label, dv.committed_at, dv.scoring_config_id, sc.body
    FROM data_version dv JOIN scoring_config sc ON sc.id = dv.scoring_config_id WHERE dv.id = ${id}`;
  if (!row) throw new Error(`data version ${id} does not exist`);
  return {
    id: Number(row.id), label: row.label, committedAt: new Date(row.committed_at), scoringConfigId: Number(row.scoring_config_id),
    config: (typeof row.body === "string" ? JSON.parse(row.body) : row.body) as ScoringConfig,
  };
}

export async function loadStaged(sql: SQL, dir: string, version: string): Promise<Build> {
  const metaFile = Bun.file(join(dir, `${version}.json`));
  if (!(await metaFile.exists())) throw new Error(`no staged build ${version} in ${dir}`);
  const meta = (await metaFile.json()) as StagedMeta;
  return {
    ...meta,
    builtAt: new Date(meta.builtAt),
    bytes: new Uint8Array(await Bun.file(join(dir, `${version}.mmdb`)).arrayBuffer()),
    rangeTable: new Uint8Array(await Bun.file(join(dir, `${version}.ranges.gz`)).arrayBuffer()),
    dataVersion: await dataVersionById(sql, meta.dataVersionId),
  };
}

/** The range table of a staged build, or null when it is not in the work directory. */
export async function stagedRangeTable(dir: string, version: string): Promise<Uint8Array | null> {
  const file = Bun.file(join(dir, `${version}.ranges.gz`));
  return (await file.exists()) ? new Uint8Array(await file.arrayBuffer()) : null;
}

// ---- notices ---------------------------------------------------------------------------------

/** FR-008a: the licence notice of every contributing source whose licence requires attribution. */
export async function noticesFor(sources: string[], wikiRoot = DEFAULT_WIKI_ENTITIES): Promise<{ notices: Notice[]; problems: string[] }> {
  const notices: Notice[] = [];
  const problems: string[] = [];
  for (const source of [...new Set(sources)].sort()) {
    const licence = await readLicence(source, wikiRoot);
    if (licence.status !== "shippable") {
      problems.push(`source ${source} is ${licence.status}; it must not reach a customer-facing snapshot`);
      continue;
    }
    if (!licence.attribution) continue;
    if (!licence.notice) {
      problems.push(`source ${source} requires attribution but its wiki page records no notice`);
      continue;
    }
    notices.push({ source, licence: licence.name ?? "unknown", notice: licence.notice });
  }
  return { notices, problems };
}

// ---- release rows ----------------------------------------------------------------------------

type RowFields = {
  status: ReleaseStatus | "validated";
  error?: string | null;
  reportPath?: string | null;
};

async function upsertRow(sql: SQL, build: Build, fields: RowFields): Promise<void> {
  const config = build.dataVersion.config;
  await sql`
    INSERT INTO snapshot_release (version, kind, base_version, data_version_id, algorithm_version, config_sha256,
                                  built_at, status, record_count, range_count, sources, report_path, error)
    VALUES (${build.version}, ${build.kind}, ${build.base}, ${build.dataVersion.id}, ${config.algorithm}, ${configSha256(config)},
            ${build.builtAt}, ${fields.status}, ${build.recordCount}, ${build.rangeCount}, ${sql.array(build.sources, "text")},
            ${fields.reportPath ?? null}, ${fields.error ?? null})
    ON CONFLICT (version) DO UPDATE SET
      kind = EXCLUDED.kind, base_version = EXCLUDED.base_version, data_version_id = EXCLUDED.data_version_id,
      algorithm_version = EXCLUDED.algorithm_version, config_sha256 = EXCLUDED.config_sha256,
      built_at = EXCLUDED.built_at, status = EXCLUDED.status, record_count = EXCLUDED.record_count,
      range_count = EXCLUDED.range_count, sources = EXCLUDED.sources, report_path = EXCLUDED.report_path,
      error = EXCLUDED.error, release_note = NULL
    WHERE snapshot_release.status <> 'published'`;
}

async function assertNotPublished(sql: SQL, version: string): Promise<void> {
  const [row] = await sql`SELECT status FROM snapshot_release WHERE version = ${version}`;
  if (row?.status === "published") throw new Error(`${version} is already published; published files are immutable`);
}

export async function currentFull(sql: SQL): Promise<{ version: string; filePath: string } | null> {
  const [row] = await sql`
    SELECT version, file_path FROM snapshot_release
    WHERE kind = 'full' AND status = 'published' AND valid_to IS NULL
    ORDER BY valid_from DESC LIMIT 1`;
  return row ? { version: row.version, filePath: row.file_path } : null;
}

// ---- pipeline --------------------------------------------------------------------------------

/**
 * Validates a fresh build and publishes it, or records it as rejected (validation failed) or
 * held (regression; published later with a release note).
 */
export async function release(sql: Db, build: Build, opts: ReleaseOptions): Promise<ReleaseResult> {
  if (!opts.disputeUrl) throw new Error("FOXTRUST_DISPUTE_URL is required to publish a snapshot (FR-008c)");
  // An invalid reference stops the release before anything is recorded (spec 003 FR-003).
  const knownGood = await loadKnownGood(opts.knownGoodFile ?? DEFAULT_KNOWN_GOOD);
  await assertNotPublished(sql, build.version);
  const result = (status: ReleaseStatus, problems: string[], path: string | null = null, reportPath: string | null = null): ReleaseResult => ({
    version: build.version, kind: build.kind, status, problems, path, reportPath,
  });

  let baseBytes: Uint8Array | undefined;
  if (build.kind === "delta") {
    const base = await currentFull(sql);
    if (!base || base.version !== build.base) throw new Error(`delta ${build.version} is based on ${build.base}, which is not the current full snapshot`);
    baseBytes = new Uint8Array(await Bun.file(join(opts.dir, base.filePath)).arrayBuffer());
  }

  await stage(build, opts.workDir);
  const problems = await validateBuild(sql, build, { baseBytes, sample: opts.sample });
  problems.push(...(await noticesFor(build.sources, opts.wikiRoot)).problems);
  if (problems.length > 0) {
    await upsertRow(sql, build, { status: "rejected", error: problems.join("\n") });
    return result("rejected", problems);
  }

  // Principle VI: every release gets a report; a regression waits for a release note.
  const report = await releaseReport(sql, build, { dir: opts.dir, baseBytes, knownGood, ...(opts.now ? { now: opts.now } : {}) });
  const stagedReport = join(opts.workDir, `${build.version}.report.json`);
  await writeAtomic(stagedReport, json(report));
  if (report.regressions.length > 0 && !opts.releaseNote) {
    await upsertRow(sql, build, { status: "held", reportPath: stagedReport });
    return result("held", report.regressions, null, stagedReport);
  }
  await upsertRow(sql, build, { status: "validated", reportPath: stagedReport });
  const { path, reportPath } = await publishFiles(sql, build, opts);
  return result("published", [], path, reportPath);
}

/** `snapshot publish <version>`: publishes a validated or held staged build. */
export async function publishStaged(sql: Db, version: string, opts: ReleaseOptions): Promise<ReleaseResult> {
  if (!opts.disputeUrl) throw new Error("FOXTRUST_DISPUTE_URL is required to publish a snapshot (FR-008c)");
  const [row] = await sql`SELECT status, report_path FROM snapshot_release WHERE version = ${version}`;
  if (!row) throw new Error(`no release ${version}`);
  if (row.status === "published") throw new Error(`${version} is already published`);
  if (row.status === "rejected") throw new Error(`${version} failed validation; rebuild it`);
  if (row.status === "held" && !opts.releaseNote) throw new Error(`${version} is held by the regression gate; --release-note "<why>" is required`);
  const build = await loadStaged(sql, opts.workDir, version);
  if (build.kind === "delta") {
    const base = await currentFull(sql);
    if (!base || base.version !== build.base) throw new Error(`delta ${version} is based on ${build.base}, which is not the current full snapshot`);
  }
  const { path, reportPath } = await publishFiles(sql, build, opts);
  return { version, kind: build.kind, status: "published", problems: [], path, reportPath };
}

async function publishFiles(sql: Db, build: Build, opts: ReleaseOptions): Promise<{ path: string; reportPath: string | null }> {
  const now = opts.now ?? new Date();
  const path = publicPath(build.kind, build.version);
  // The release report goes public with the file, carrying the release note (research R11).
  const staged = Bun.file(join(opts.workDir, `${build.version}.report.json`));
  let reportPath: string | null = null;
  if (await staged.exists()) {
    const report = (await staged.json()) as ReleaseReport;
    report.releaseNote = opts.releaseNote ?? null;
    reportPath = `v1/reports/${build.version}.json`;
    await writeAtomic(join(opts.dir, reportPath), json(report));
  }
  const signature = await sign(build.bytes, opts.key);
  // The file first, then its signature: a client that sees the manifest finds both.
  await writeAtomic(join(opts.dir, path), build.bytes);
  await writeAtomic(join(opts.dir, `${path}.sig`), signature);
  await ensureKeyListed(opts.dir, opts.key, now);

  await sql.begin(async (tx) => {
    await tx`
      UPDATE snapshot_release SET valid_to = ${now}
      WHERE status = 'published' AND valid_to IS NULL AND (kind = ${build.kind} OR ${build.kind === "full"})`;
    await tx`
      UPDATE snapshot_release SET status = 'published', valid_from = ${now}, valid_to = NULL, file_path = ${path},
             sha256 = ${sha256(build.bytes)}, size_bytes = ${build.bytes.length}, signing_key_id = ${opts.key.keyId},
             release_note = ${opts.releaseNote ?? null}, report_path = ${reportPath}
      WHERE version = ${build.version}`;
  });
  await writeIndexes(sql, opts, now);
  return { path, reportPath };
}

/** Adds the signing key to `v1/keys.json` when it is missing, and re-signs the file. */
async function ensureKeyListed(dir: string, key: SigningKey, now: Date): Promise<PublicKeyInfo[]> {
  const path = join(dir, "v1", "keys.json");
  let keys = await readKeysFile(path);
  if (!keys.some((k) => k.keyId === key.keyId)) {
    keys = [...keys, { keyId: key.keyId, publicKey: key.publicKey, validFrom: now.toISOString(), validTo: null }];
    await writeKeysFile(`${path}.tmp`, keys);
    await rename(`${path}.tmp`, path);
  }
  const bytes = new Uint8Array(await Bun.file(path).arrayBuffer());
  await writeAtomic(`${path}.sig`, await sign(bytes, key));
  return keys;
}

type PublishedRow = {
  version: string; kind: "full" | "delta"; base_version: string | null; file_path: string; sha256: string; size_bytes: string;
  built_at: Date; label: string; algorithm_version: string; config_sha256: string; signing_key_id: string;
  valid_from: Date; valid_to: Date | null; release_note: string | null; sources: string[];
};

const manifestFile = (r: PublishedRow) => ({
  version: r.version,
  path: r.file_path,
  sha256: r.sha256,
  size: Number(r.size_bytes),
  builtAt: new Date(r.built_at).toISOString(),
  dataVersion: r.label,
  algorithm: r.algorithm_version,
  configSha256: r.config_sha256,
  keyId: r.signing_key_id,
  ...(r.kind === "delta" ? { base: r.base_version } : {}),
});

/** Rewrites `v1/manifest.json` and `v1/archive/index.json` (each with its `.sig`) from the release rows. */
export async function writeIndexes(sql: Db, opts: Pick<ReleaseOptions, "dir" | "key" | "disputeUrl" | "wikiRoot">, now = new Date()): Promise<void> {
  if (!opts.disputeUrl) throw new Error("FOXTRUST_DISPUTE_URL is required to publish a snapshot (FR-008c)");
  const rows = (await sql`
    SELECT r.version, r.kind, r.base_version, r.file_path, r.sha256, r.size_bytes, r.built_at, dv.label, r.algorithm_version,
           r.config_sha256, r.signing_key_id, r.valid_from, r.valid_to, r.release_note, r.sources
    FROM snapshot_release r JOIN data_version dv ON dv.id = r.data_version_id
    WHERE r.status = 'published'
    ORDER BY r.valid_from, r.id`) as PublishedRow[];

  const full = rows.filter((r) => r.kind === "full" && r.valid_to === null).at(-1);
  if (!full) throw new Error("no published full snapshot");
  const delta = rows.filter((r) => r.kind === "delta" && r.valid_to === null && r.base_version === full.version).at(-1) ?? null;
  const latest = delta ?? full;
  const { notices, problems } = await noticesFor([...full.sources, ...(delta?.sources ?? [])], opts.wikiRoot);
  if (problems.length > 0) throw new Error(problems.join("\n"));

  const manifest = {
    format: 1,
    generatedAt: now.toISOString(),
    full: manifestFile(full),
    delta: delta ? manifestFile(delta) : null,
    keys: await readKeysFile(join(opts.dir, "v1", "keys.json")),
    notices,
    releaseNote: latest.release_note,
    disputeUrl: opts.disputeUrl,
  };
  const archive = rows.map((r) => ({
    version: r.version,
    kind: r.kind,
    base: r.base_version,
    path: r.file_path,
    sha256: r.sha256,
    validFrom: new Date(r.valid_from).toISOString(),
    validTo: r.valid_to ? new Date(r.valid_to).toISOString() : null,
    algorithm: r.algorithm_version,
    configSha256: r.config_sha256,
  }));

  for (const [path, value] of [["v1/archive/index.json", archive], ["v1/manifest.json", manifest]] as const) {
    const bytes = new TextEncoder().encode(json(value));
    const target = join(opts.dir, path);
    // The signature goes first: a client never pairs a new file with a stale signature for long,
    // and a mismatch only makes it keep its current data.
    await writeAtomic(`${target}.sig`, await sign(bytes, opts.key));
    await writeAtomic(target, bytes);
  }
}

/**
 * One scheduler or CLI run: build the next full snapshot, or the cumulative delta over the
 * current full snapshot, and release it. A delta without a published full snapshot is skipped.
 */
export async function buildAndRelease(
  sql: Db,
  kind: "full" | "delta",
  opts: ReleaseOptions & { at?: Date },
): Promise<ReleaseResult | { status: "skipped"; reason: string }> {
  const at = opts.at ?? opts.now ?? new Date();
  const version = kind === "full" ? fullVersion(at) : deltaVersion(at);
  const [existing] = await sql`SELECT status FROM snapshot_release WHERE version = ${version}`;
  if (existing?.status === "published") return { status: "skipped", reason: `${version} is already published` };
  if (kind === "full") return release(sql, await buildFull(sql, { at, disputeUrl: opts.disputeUrl }), opts);

  const base = await currentFull(sql);
  if (!base) return { status: "skipped", reason: "no full snapshot is published yet" };
  let baseTable = await stagedRangeTable(opts.workDir, base.version);
  if (!baseTable) {
    // The work directory was lost: the data is temporal, so the base's view can be rebuilt.
    const [row] = await sql`SELECT built_at FROM snapshot_release WHERE version = ${base.version}`;
    baseTable = (await buildFull(sql, { at: new Date(row.built_at), disputeUrl: opts.disputeUrl })).rangeTable;
  }
  const build = await buildDelta(sql, { at, base: base.version, baseTable, disputeUrl: opts.disputeUrl });
  return release(sql, build, opts);
}

/**
 * Runs `fn` under the advisory lock `snapshot`. Returns null when another build holds it, unless
 * `wait` is set: the daily full build waits for an hourly delta that fired at the same minute.
 */
export async function withSnapshotLock<T>(sql: Db, fn: () => Promise<T>, opts: { wait?: boolean } = {}): Promise<T | null> {
  const conn = await sql.reserve();
  try {
    if (opts.wait) await conn`SELECT pg_advisory_lock(hashtext('snapshot'))`;
    else {
      const [{ locked }] = await conn`SELECT pg_try_advisory_lock(hashtext('snapshot')) AS locked`;
      if (!locked) return null;
    }
    try {
      return await fn();
    } finally {
      await conn`SELECT pg_advisory_unlock(hashtext('snapshot'))`;
    }
  } finally {
    conn.release();
  }
}

/** Release settings from the environment (scheduler and CLI). */
export async function releaseOptionsFromEnv(): Promise<ReleaseOptions> {
  const keyPath = Bun.env.FOXTRUST_SIGNING_KEY;
  if (!keyPath) throw new Error("FOXTRUST_SIGNING_KEY is not set");
  return {
    dir: publicationDir(),
    workDir: workDir(),
    key: await loadSigningKey(keyPath),
    disputeUrl: Bun.env.FOXTRUST_DISPUTE_URL?.trim() || null,
    ...(Bun.env.FOXTRUST_KNOWN_GOOD?.trim() ? { knownGoodFile: Bun.env.FOXTRUST_KNOWN_GOOD.trim() } : {}),
  };
}
