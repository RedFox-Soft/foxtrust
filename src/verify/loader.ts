import { fetchBoundedResponse, FeedFetchError } from "../ingest/fetch";
import type { IpValue } from "../ip/parse";
import type { Level } from "../model/types";
import { openMmdb, overlay, type Mmdb } from "../mmdb/reader";
import type { MmdbValue } from "../mmdb/writer";
import { verify, type TrustedKey } from "../snapshot/sign";
import type { VerdictSource } from "../decision/engine";
import type { CustomerVerdict } from "../verdict/customer";

/**
 * Snapshot loader (spec 002 FR-013–FR-016, contracts/publication.md client procedure).
 * Downloads the manifest, verifies every file against pinned keys, and swaps the in-memory
 * full + delta pair in one step. No database; the stage 3 SDK builds on this module.
 */

/** Same budget as the publisher (src/snapshot/build.ts SIZE_BUDGET_BYTES). */
export const MAX_SNAPSHOT_BYTES = 250 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const SIGNATURE_BYTES = 64;
const DATABASE_TYPE = "FoxTrust-Customer-Verdict";
const TIMEOUT_MS = 120_000;

export type LoaderOptions = {
  publicationUrl: string;
  trustedKeys: TrustedKey[];
  maxAgeHours: number;
  clock?: () => Date;
  /** Download limit per snapshot file. */
  maxBytes?: number;
};

type ManifestFile = { version: string; path: string; sha256: string; size: number; builtAt: string; base?: string };
type Manifest = { format: 1; full: ManifestFile; delta: ManifestFile | null };

type Loaded = { version: string; builtAt: Date; db: Mmdb };

export type LoadedState = {
  full: Loaded;
  delta: Loaded | null;
  lookup: (ip: IpValue) => CustomerVerdict | null;
};

export type LoaderStatus = {
  snapshotVersion: string | null;
  deltaVersion: string | null;
  builtAt: string | null;
  ageSeconds: number | null;
  stale: boolean;
  lastCheckAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
};

export type Loader = {
  /** One update check (the scheduled job calls this). Never throws. */
  check(): Promise<void>;
  /** Runs `check` now and then on the cron schedule; returns a stop function. */
  start(schedule: string): () => void;
  current(): LoadedState | null;
  source(): VerdictSource;
  status(): LoaderStatus;
};

class LoadError extends Error {}

const sha256 = (bytes: Uint8Array) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function parseFile(value: unknown, what: string): ManifestFile {
  if (!isObject(value)) throw new LoadError(`manifest ${what} is missing`);
  const { version, path, sha256: sha, size, builtAt, base } = value;
  if (typeof version !== "string" || !/^(f\d{8}|d\d{8}T\d{2})$/.test(version)) throw new LoadError(`manifest ${what}.version is invalid`);
  if (typeof path !== "string" || !/^v1\/(full|delta)\/[fd][0-9T]+\.mmdb$/.test(path)) throw new LoadError(`manifest ${what}.path is invalid`);
  if (typeof sha !== "string" || !/^[0-9a-f]{64}$/.test(sha)) throw new LoadError(`manifest ${what}.sha256 is invalid`);
  if (typeof size !== "number" || !Number.isInteger(size) || size < 1) throw new LoadError(`manifest ${what}.size is invalid`);
  if (typeof builtAt !== "string" || Number.isNaN(Date.parse(builtAt))) throw new LoadError(`manifest ${what}.builtAt is invalid`);
  if (base !== undefined && typeof base !== "string") throw new LoadError(`manifest ${what}.base is invalid`);
  return { version, path, sha256: sha, size, builtAt, ...(base !== undefined ? { base } : {}) };
}

function parseManifest(bytes: Uint8Array): Manifest {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new LoadError("manifest is not JSON");
  }
  if (!isObject(value) || value.format !== 1) throw new LoadError("manifest format is not 1");
  return {
    format: 1,
    full: parseFile(value.full, "full"),
    delta: value.delta === null || value.delta === undefined ? null : parseFile(value.delta, "delta"),
  };
}

/** MMDB record → customer verdict (contracts/snapshot-record.schema.json). */
function toVerdict(value: MmdbValue | null): CustomerVerdict | null {
  if (!isObject(value)) return null;
  const r = value as Record<string, MmdbValue>;
  const network = isObject(r.network) ? (r.network as Record<string, MmdbValue>) : {};
  const reasons = Array.isArray(r.reasons) ? r.reasons : [];
  return {
    risk: Number(r.risk ?? 0),
    level: (typeof r.level === "string" ? r.level : "low") as Level,
    categories: Array.isArray(r.categories) ? r.categories.map(String) : [],
    reasons: reasons.filter(isObject).map((x) => {
      const reason = x as Record<string, MmdbValue>;
      return {
        code: typeof reason.code === "string" ? reason.code : "",
        lastSeen: new Date(Number(reason.last_seen) * 1000).toISOString(),
        contribution: Number(reason.contribution ?? 0),
      };
    }),
    network: {
      asn: typeof network.asn === "number" ? network.asn : null,
      org: typeof network.org === "string" ? network.org : null,
      prefix: null,
      country: typeof network.country === "string" ? network.country : null,
    },
  };
}

function makeState(full: Loaded, delta: Loaded | null): LoadedState {
  const get = overlay(full.db, delta?.db ?? null);
  return { full, delta, lookup: (ip) => toVerdict(get(ip)) };
}

export function createLoader(opts: LoaderOptions): Loader {
  const clock = opts.clock ?? (() => new Date());
  const base = opts.publicationUrl.replace(/\/+$/, "");
  const allowHttp = base.startsWith("http://");
  const maxBytes = opts.maxBytes ?? MAX_SNAPSHOT_BYTES;

  let state: LoadedState | null = null;
  let manifestEtag: string | null = null;
  let lastCheckAt: Date | null = null;
  let lastSuccessAt: Date | null = null;
  let lastError: string | null = null;
  let running: Promise<void> | null = null;

  async function get(path: string, limit: number, headers: Record<string, string> = {}) {
    try {
      return await fetchBoundedResponse(`${base}/${path}`, { maxCompressedBytes: limit, maxRedirects: 3 }, AbortSignal.timeout(TIMEOUT_MS), {
        allowHttp,
        headers,
      });
    } catch (error) {
      if (error instanceof FeedFetchError) throw new LoadError(`${path}: ${error.message}`);
      throw error;
    }
  }

  async function signed(path: string, limit: number): Promise<Uint8Array> {
    const [file, sig] = await Promise.all([get(path, limit), get(`${path}.sig`, SIGNATURE_BYTES)]);
    const result = await verify(file.body!, sig.body!, opts.trustedKeys);
    if (!result.ok) throw new LoadError(`${path}: signature does not verify with a trusted key`);
    return file.body!;
  }

  async function loadFile(file: ManifestFile): Promise<Loaded> {
    if (file.size > maxBytes) throw new LoadError(`${file.path}: ${file.size} bytes is over the ${maxBytes} limit`);
    const bytes = await signed(file.path, Math.min(maxBytes, file.size));
    if (bytes.length !== file.size) throw new LoadError(`${file.path}: size ${bytes.length} differs from the manifest (${file.size})`);
    if (sha256(bytes) !== file.sha256) throw new LoadError(`${file.path}: sha256 differs from the manifest`);
    let db: Mmdb;
    try {
      db = openMmdb(bytes);
    } catch (error) {
      throw new LoadError(`${file.path}: not a readable MMDB file (${(error as Error).message})`);
    }
    if (db.metadata.database_type !== DATABASE_TYPE) throw new LoadError(`${file.path}: unexpected database_type ${db.metadata.database_type}`);
    return { version: file.version, builtAt: new Date(file.builtAt), db };
  }

  async function run(): Promise<void> {
    lastCheckAt = clock();
    try {
      const response = await get("v1/manifest.json", MAX_MANIFEST_BYTES, manifestEtag && state ? { "If-None-Match": manifestEtag } : {});
      if (response.status === 304) {
        lastSuccessAt = clock();
        lastError = null;
        return;
      }
      const sig = await get("v1/manifest.json.sig", SIGNATURE_BYTES);
      if (!(await verify(response.body!, sig.body!, opts.trustedKeys)).ok) throw new LoadError("manifest signature");
      const manifest = parseManifest(response.body!);

      // The full snapshot first; a delta is applied only on top of its own base (US2-5).
      const full = state?.full.version === manifest.full.version ? state.full : await loadFile(manifest.full);
      let delta: Loaded | null = null;
      let deltaError: string | null = null;
      if (manifest.delta) {
        if (manifest.delta.base !== full.version) {
          deltaError = `delta ${manifest.delta.version} is based on ${manifest.delta.base}, not ${full.version}; not applied`;
        } else if (state?.full === full && state.delta?.version === manifest.delta.version) {
          delta = state.delta;
        } else {
          try {
            delta = await loadFile(manifest.delta);
          } catch (error) {
            if (!(error instanceof LoadError)) throw error;
            deltaError = error.message;
            // Keep the delta we have when it still belongs to this full snapshot.
            delta = state?.full === full ? state.delta : null;
          }
        }
      }

      if (state?.full !== full || state.delta !== delta) state = makeState(full, delta); // one atomic swap
      if (deltaError) {
        lastError = deltaError;
        return;
      }
      manifestEtag = response.headers.get("etag");
      lastSuccessAt = clock();
      lastError = null;
    } catch (error) {
      lastError = error instanceof LoadError ? error.message : `unexpected: ${(error as Error).message}`;
    }
  }

  const loader: Loader = {
    check() {
      // Checks never overlap; a caller during a check waits for the same one.
      running ??= run().finally(() => {
        running = null;
      });
      return running;
    },
    start(schedule) {
      void loader.check();
      const job = Bun.cron(schedule, () => loader.check(), { tz: "UTC" });
      return () => job.stop();
    },
    current: () => state,
    source: () => {
      const s = state;
      return {
        snapshotVersion: s ? (s.delta ? `${s.full.version}+${s.delta.version}` : s.full.version) : null,
        lookup: (ip) => (s ? s.lookup(ip) : null),
      };
    },
    status() {
      const s = state;
      const builtAt = s ? (s.delta?.builtAt ?? s.full.builtAt) : null;
      const ageSeconds = builtAt ? Math.max(0, Math.floor((clock().getTime() - builtAt.getTime()) / 1000)) : null;
      return {
        snapshotVersion: s?.full.version ?? null,
        deltaVersion: s?.delta?.version ?? null,
        builtAt: builtAt?.toISOString() ?? null,
        ageSeconds,
        stale: ageSeconds === null || ageSeconds > opts.maxAgeHours * 3600,
        lastCheckAt: lastCheckAt?.toISOString() ?? null,
        lastSuccessAt: lastSuccessAt?.toISOString() ?? null,
        lastError,
      };
    },
  };
  return loader;
}
