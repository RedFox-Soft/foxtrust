import { mkdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { DEFAULT_LIMITS, type FeedDefinition, type FeedFile, type FeedFileSpec, type FeedLimits } from "../feeds/types";

export type FetchErrorCode = "size_limit" | "timeout" | "insecure_redirect" | "http_error" | "network_error";

/** A download that was refused or aborted. The run fails and stored data stays (research R14). */
export class FeedFetchError extends Error {
  constructor(
    readonly code: FetchErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export type FetchedFeed = { files: FeedFile[] };

const USER_AGENT = "FoxTrust-ingest/0.1";

export function limitsFor(def: FeedDefinition): FeedLimits {
  return { ...DEFAULT_LIMITS, ...def.limits };
}

/** `ipv4.v2.txt` → `ipv4.txt`: optional `.vN` version suffix before the extension. */
export function baseFileName(path: string): string {
  return basename(path).replace(/\.v\d+(?=\.)/, "");
}

/**
 * Matches local files to the definition's files by base name. A single-file feed accepts any
 * file name. Throws with the missing names when a multi-file feed gets only some of its files.
 */
export function matchLocalFiles(def: FeedDefinition, paths: string[]): { name: string; path: string }[] {
  // A definition with no files (e.g. an invalid cloud ASN list, spec 005) reads nothing; its parse reports why.
  if (def.files.length === 0) return [];
  if (def.files.length === 1 && paths.length === 1) return [{ name: def.files[0]!.name, path: paths[0]! }];
  const byName = new Map(paths.map((p) => [baseFileName(p), p]));
  const unknown = paths.filter((p) => !def.files.some((f) => f.name === baseFileName(p)));
  if (unknown.length > 0) throw new Error(`${def.id}: unexpected file(s) ${unknown.join(", ")}`);
  const missing = def.files.filter((f) => !byName.has(f.name)).map((f) => f.name);
  if (missing.length > 0) throw new Error(`${def.id}: missing file(s) ${missing.join(", ")}`);
  return def.files.map((f) => ({ name: f.name, path: byName.get(f.name)! }));
}

/** Reads a stream fully, failing as soon as it exceeds `maxBytes`. */
export async function readBounded(stream: ReadableStream<Uint8Array>, maxBytes: number, what: string): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new FeedFetchError("size_limit", `${what} exceeds ${maxBytes} bytes`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

const isGzip = (bytes: Uint8Array) => bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;

/** Decompresses gzip data as a stream, so a gzip bomb stops at the limit instead of filling memory. */
async function gunzipBounded(bytes: Uint8Array, maxBytes: number, what: string): Promise<Uint8Array> {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return readBounded(stream, maxBytes, `${what} (decompressed)`);
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

export type FetchOptions = {
  /** Plain http to loopback hosts (tests with a local server only). */
  allowLoopbackHttp?: boolean;
  /**
   * Plain http to any host. Only for our own signed publication, where integrity comes from
   * the signatures (spec 002 research R5); third-party feeds stay https-only.
   */
  allowHttp?: boolean;
  headers?: Record<string, string>;
};

/** https only, unless the caller allows plain http. */
function isAllowed(url: URL, opts: FetchOptions): boolean {
  if (url.protocol === "https:") return true;
  if (url.protocol !== "http:") return false;
  return opts.allowHttp === true || (opts.allowLoopbackHttp === true && LOOPBACK.has(url.hostname));
}

async function fetchBounded(url: string, limits: FeedLimits, signal: AbortSignal, allowLoopbackHttp = false): Promise<Uint8Array> {
  const response = await fetchBoundedResponse(url, limits, signal, { allowLoopbackHttp });
  return response.body!;
}

/**
 * A bounded GET with manual, protocol-checked redirects. `304 Not Modified` (for conditional
 * `headers`) returns `body: null`; other non-2xx statuses throw.
 */
export async function fetchBoundedResponse(
  url: string,
  limits: Pick<FeedLimits, "maxCompressedBytes" | "maxRedirects">,
  signal: AbortSignal,
  opts: FetchOptions = {},
): Promise<{ status: number; headers: Headers; body: Uint8Array | null }> {
  let current = new URL(url);
  if (!isAllowed(current, opts)) {
    throw new FeedFetchError("insecure_redirect", `refusing non-https URL ${url}`);
  }
  for (let redirects = 0; ; redirects++) {
    let response: Response;
    try {
      response = await fetch(current, {
        redirect: "manual",
        signal,
        headers: { "User-Agent": USER_AGENT, "Accept-Encoding": "identity", ...opts.headers },
      });
    } catch (error) {
      if (signal.aborted) throw new FeedFetchError("timeout", `timed out fetching ${current.href}`);
      throw new FeedFetchError("network_error", `cannot fetch ${current.href}: ${(error as Error).message}`);
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (!location) throw new FeedFetchError("http_error", `redirect without Location from ${current.href}`);
      const next = new URL(location, current);
      if (!isAllowed(next, opts)) {
        throw new FeedFetchError("insecure_redirect", `redirect to non-https ${next.href}`);
      }
      if (redirects + 1 > limits.maxRedirects) throw new FeedFetchError("http_error", `too many redirects from ${url}`);
      current = next;
      continue;
    }
    if (response.status === 304) {
      await response.body?.cancel();
      return { status: 304, headers: response.headers, body: null };
    }
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new FeedFetchError("http_error", `HTTP ${response.status} from ${current.href}`);
    }
    try {
      const body = await readBounded(response.body, limits.maxCompressedBytes, `response from ${current.href}`);
      return { status: response.status, headers: response.headers, body };
    } catch (error) {
      if (signal.aborted) throw new FeedFetchError("timeout", `timed out reading ${current.href}`);
      throw error;
    }
  }
}

async function decode(raw: Uint8Array, limits: FeedLimits, what: string): Promise<Uint8Array> {
  return isGzip(raw) ? gunzipBounded(raw, limits.maxDecompressedBytes, what) : raw;
}

/**
 * Downloads (or reads locally) every file of a feed within the limits of research R14.
 * Local files go through the same limits as downloads.
 */
export async function fetchFeed(
  def: FeedDefinition,
  opts: {
    fromFiles?: string[];
    /** Overrides download URLs by file name (tests). Skips `resolveFiles`. */
    urls?: Record<string, string>;
    /** Allows plain http to loopback hosts (tests with a local server only). */
    allowLoopbackHttp?: boolean;
  } = {},
): Promise<FetchedFeed> {
  const limits = limitsFor(def);
  const files: FeedFile[] = [];

  if (opts.fromFiles && opts.fromFiles.length > 0) {
    for (const { name, path } of matchLocalFiles(def, opts.fromFiles)) {
      const file = Bun.file(path);
      if (file.size > limits.maxCompressedBytes) {
        throw new FeedFetchError("size_limit", `${path} exceeds ${limits.maxCompressedBytes} bytes`);
      }
      const raw = await readBounded(file.stream(), limits.maxCompressedBytes, path);
      files.push({ name, body: await decode(raw, limits, path) });
    }
    return { files };
  }

  const signal = AbortSignal.timeout(limits.timeoutMs);
  let specs: FeedFileSpec[] = def.files.map((f) => ({ ...f, url: opts.urls?.[f.name] ?? f.url }));
  if (def.resolveFiles && !opts.urls) {
    const fetchText = async (url: string) =>
      new TextDecoder().decode(await fetchBounded(url, limits, signal, opts.allowLoopbackHttp));
    specs = await def.resolveFiles(fetchText);
  }
  for (const spec of specs) {
    const raw = await fetchBounded(spec.url, limits, signal, opts.allowLoopbackHttp);
    files.push({ name: spec.name, body: await decode(raw, limits, spec.url) });
  }
  return { files };
}

/** Saves the fetched files gzipped under `<root>/<feed>/<runId>/` for held-run confirmation. */
export async function saveArtifacts(root: string, feedId: string, runId: number, files: FeedFile[]): Promise<string> {
  const dir = join(root, feedId, String(runId));
  await mkdir(dir, { recursive: true });
  for (const file of files) await Bun.write(join(dir, `${file.name}.gz`), Bun.gzipSync(file.body as Uint8Array<ArrayBuffer>));
  return dir;
}

export async function loadArtifacts(dir: string, def: FeedDefinition): Promise<FeedFile[]> {
  const files: FeedFile[] = [];
  for (const spec of def.files) {
    const bytes = new Uint8Array(await Bun.file(join(dir, `${spec.name}.gz`)).arrayBuffer());
    files.push({ name: spec.name, body: Bun.gunzipSync(bytes) });
  }
  return files;
}
