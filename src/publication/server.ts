import { Elysia } from "elysia";
import { realpath, stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

/**
 * Read-only static server for the public snapshot files (contracts/publication.md, research R5).
 * GET/HEAD only; ETag = sha256 of the file; 304 on validators; no directory listing;
 * anything outside `<dir>/v1/` is 404.
 */

const SAFE_PATH = /^\/v1\/[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;

function cacheControl(path: string): string {
  if (/^\/v1\/(full|delta|reports)\//.test(path)) return "public, max-age=31536000, immutable";
  if (path.startsWith("/v1/keys.json")) return "public, max-age=300";
  return "public, max-age=60";
}

function contentType(path: string): string {
  return path.endsWith(".json") ? "application/json" : "application/octet-stream";
}

export function createPublicationApp(dir: string) {
  const root = resolve(dir);
  const etags = new Map<string, { key: string; etag: string }>();
  let requests = 0;

  const notFound = () => new Response("not found\n", { status: 404 });

  const app = new Elysia().all("*", async ({ request }) => {
    requests++;
    const method = request.method.toUpperCase();
    if (method !== "GET" && method !== "HEAD") return new Response("method not allowed\n", { status: 405, headers: { Allow: "GET, HEAD" } });

    let path: string;
    try {
      path = decodeURIComponent(new URL(request.url).pathname);
    } catch {
      return notFound();
    }
    if (!SAFE_PATH.test(path) || path.split("/").some((part) => part === "." || part === "..")) return notFound();

    const candidate = join(root, ...path.split("/").filter(Boolean));
    let real: string;
    let info;
    try {
      real = await realpath(candidate);
      info = await stat(real);
    } catch {
      return notFound();
    }
    // Symlinks or odd paths must not escape the publication root.
    const realRoot = await realpath(root).catch(() => root);
    if (!(real === realRoot || real.startsWith(realRoot + sep)) || !info.isFile()) return notFound();

    const cacheKey = `${info.size}:${info.mtimeMs}`;
    let entry = etags.get(real);
    if (!entry || entry.key !== cacheKey) {
      const digest = new Bun.CryptoHasher("sha256").update(await Bun.file(real).bytes()).digest("hex");
      entry = { key: cacheKey, etag: `"${digest}"` };
      etags.set(real, entry);
    }
    const headers: Record<string, string> = {
      ETag: entry.etag,
      "Last-Modified": new Date(info.mtimeMs).toUTCString(),
      "Cache-Control": cacheControl(path),
      "Content-Type": contentType(path),
      "Content-Length": String(info.size),
    };
    const ifNoneMatch = request.headers.get("if-none-match");
    const ifModifiedSince = request.headers.get("if-modified-since");
    const notModified =
      (ifNoneMatch !== null && ifNoneMatch.split(",").map((s) => s.trim()).includes(entry.etag)) ||
      (ifNoneMatch === null && ifModifiedSince !== null && Date.parse(ifModifiedSince) >= Math.floor(info.mtimeMs / 1000) * 1000);
    if (notModified) {
      const { "Content-Length": _len, ...rest } = headers;
      return new Response(null, { status: 304, headers: rest });
    }
    return new Response(method === "HEAD" ? null : Bun.file(real), { status: 200, headers });
  });

  return { app, requests: () => requests };
}

export function startPublicationServer(opts: { dir: string; port: number; hostname?: string }) {
  const { app, requests } = createPublicationApp(opts.dir);
  app.listen({ port: opts.port, hostname: opts.hostname ?? "0.0.0.0" });
  return {
    port: app.server!.port as number,
    requests,
    stop: async () => {
      await app.stop();
    },
  };
}
