import type { SQL } from "bun";
import { Elysia } from "elysia";
import { join } from "node:path";
import type { Accounts } from "../api/accounts";
import { pageHeaders } from "../web/html";
import type { Oidc } from "../web/oidc";
import { createStatic } from "../web/static";
import type { Page, PageName } from "./content";
import { messagePage, notFoundPage, ROBOTS, textPage, type Visitor } from "./pages";

/**
 * The public site (spec 012 contracts/site-http.md). Public pages are rendered once at start and need
 * neither the database nor foxauth. Pages carry no script. No line is logged per request (FR-024).
 */

/** Sign-in and self-service keys; null in public-only mode (research R8). */
export type SiteSignInDeps = {
  sql: SQL;
  oidc: Oidc;
  accounts: Accounts;
  /** foxauth issuer: half of an account's identity. */
  issuer: string;
  contact: string;
  maxKeys: number;
  keysPerDay: number;
};

export type SiteDeps = {
  /** The site's origin, e.g. https://foxtrust.dev; redirect URIs and origin checks use it. */
  url: string;
  content: Record<PageName, Page>;
  signIn: SiteSignInDeps | null;
  clock?: () => Date;
  log?: (line: string) => void;
};

/** Public text pages by path (contracts/site-http.md). */
const PUBLIC: Record<string, PageName> = {
  "/": "landing",
  "/dispute": "dispute",
  "/docs/api": "api",
  "/docs/snapshots": "snapshots",
  "/privacy": "privacy",
  "/terms": "terms",
};

export function createSiteApp(deps: SiteDeps) {
  const log = deps.log ?? (() => {});
  const assets = createStatic({ "/static/site.css": join(import.meta.dir, "static", "site.css") });
  const anonymous: Visitor = { signInEnabled: deps.signIn !== null, session: null };
  // Public pages are the same for everyone: render them once.
  const rendered = new Map(Object.entries(PUBLIC).map(([path, name]) => [path, textPage(deps.content[name], anonymous)]));

  const html = (status: number, body: string, cache: "no-store" | "public" = "no-store", extra: Record<string, string> = {}) =>
    new Response(body, { status, headers: { ...pageHeaders(cache), ...extra } });

  async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method === "HEAD" ? "GET" : request.method;

    if (method === "GET") {
      const page = rendered.get(path);
      if (page) return html(200, page, "public");
      if (path === "/robots.txt") return new Response(ROBOTS, { headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=300" } });
      const asset = await assets.serve(path);
      if (asset) return asset;
      return html(404, notFoundPage(anonymous));
    }
    return html(405, messagePage("Not allowed", "This method is not supported.", anonymous), "no-store", { Allow: "GET, HEAD" });
  }

  /** HEAD answers like GET without a body. */
  const respond = async (request: Request) => {
    const res = await handle(request);
    return request.method === "HEAD" ? new Response(null, { status: res.status, headers: res.headers }) : res;
  };

  const app = new Elysia()
    .all("/*", ({ request }) => respond(request), { parse: "none" })
    .all("/", ({ request }) => respond(request), { parse: "none" })
    .onError(({ error }) => {
      log(`site: error: ${error instanceof Error ? error.message : "unknown"}`);
      return html(500, messagePage("Something went wrong", "The page could not be shown. Try again later.", anonymous, false));
    });
  return { app, handle: respond };
}

export function startSiteServer(deps: SiteDeps & { port: number; hostname?: string }) {
  const { app } = createSiteApp(deps);
  app.listen({ port: deps.port, hostname: deps.hostname ?? "0.0.0.0" });
  return {
    port: app.server!.port as number,
    stop: async () => {
      await app.stop();
    },
  };
}
