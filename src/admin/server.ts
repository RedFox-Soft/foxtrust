import type { SQL } from "bun";
import { Elysia } from "elysia";
import { join } from "node:path";
import { NotFoundError, ValidationError, type Accounts } from "../api/accounts";
import { audit, latestAudit } from "./audit";
import { feeds, overview, PAGE_SIZE, releaseOf, releases, runOf } from "./data";
import { OidcError, type Oidc } from "../web/oidc";
import {
  accountPage, accountsPage, auditPage, confirmPage, escape, feedsPage, field, keyPage, keysPage, layout, messagePage, overviewPage, pageHeaders,
  releasesPage, secretPage, type PageSession,
} from "./pages";
import { listRequests, requestRelease, requestRunConfirm, RequestError } from "./requests";
import { MAX_FORM, postAllowed, safeReturn } from "../web/forms";
import { cookieNames, createSessions, readCookie, type Session } from "../web/session";
import { createStatic } from "../web/static";

export { safeReturn } from "../web/forms";
export { beerStylesheet } from "../web/static";

/**
 * The admin panel (spec 011 contracts/admin-http.md). Every route needs an operator session except
 * sign-in and the stylesheet; every change is a same-origin form post with the session's CSRF token,
 * and is audited. Pages carry no script.
 */

export type AdminDeps = {
  sql: SQL;
  oidc: Oidc;
  accounts: Accounts;
  /** The panel's origin, e.g. https://admin.foxtrust.dev; redirect URIs are built from it. */
  url: string;
  group: string;
  clock?: () => Date;
  log?: (line: string) => void;
};

/** Operator sessions last 8 hours (spec 011 research R2). */
const SESSION_HOURS = 8;

type Ctx = { request: Request; url: URL; params: string[]; session: Session; page: PageSession; form: URLSearchParams };
type Handler = (ctx: Ctx) => Promise<Response> | Response;

export function createAdminApp(deps: AdminDeps) {
  const clock = deps.clock ?? (() => new Date());
  const log = deps.log ?? (() => {});
  const origin = new URL(deps.url).origin;
  const names = cookieNames(deps.url.startsWith("https://"), "foxtrust_admin");
  const sessions = createSessions(deps.sql, { table: "admin_session", hours: SESSION_HOURS }, clock);
  const groupKey = deps.group.toLowerCase();
  const assets = createStatic({ "/static/admin.css": join(import.meta.dir, "static", "admin.css") });

  const html = (status: number, body: string, headers: Headers | Record<string, string> = {}) => {
    const h = new Headers(pageHeaders());
    for (const [k, v] of headers instanceof Headers ? headers.entries() : Object.entries(headers)) h.append(k, v);
    return new Response(body, { status, headers: h });
  };
  const redirect = (location: string, status = 303, headers = new Headers()) => {
    headers.set("Location", location);
    return html(status, "", headers);
  };
  const who = (s: Session) => ({ subject: s.subject, name: s.name });
  const pageOf = (s: Session): PageSession => ({ name: s.name, csrf: s.csrf });
  const pageNumber = (url: URL) => {
    const n = Number(url.searchParams.get("page") ?? "0");
    return Number.isSafeInteger(n) && n >= 0 && n < 100_000 ? n : 0;
  };
  /** A short message inside the signed-in layout. */
  const messagePageWith = (s: PageSession, title: string, text: string) => layout({ title, session: s, body: `<p>${escape(text)}</p>` });
  const notFound = (s: PageSession) => html(404, messagePageWith(s, "Not found", "There is nothing here."));

  /** Optional numeric form field: empty means "use the default" (null). */
  const optionalInt = (form: URLSearchParams, name: string): number | null | "invalid" => {
    const raw = form.get(name)?.trim() ?? "";
    if (raw === "") return null;
    const n = Number(raw);
    return Number.isInteger(n) ? n : "invalid";
  };

  // --- Routes behind a session --------------------------------------------------------------

  const gets: [RegExp, Handler][] = [
    [/^\/$/, async ({ page }) => html(200, overviewPage(page, await overview(deps.sql, clock()), clock()))],
    [/^\/accounts$/, async ({ page, url }) => {
      const n = pageNumber(url);
      const all = await deps.accounts.listAccounts();
      const newest = [...all].reverse();
      return html(200, accountsPage(page, newest.slice(n * PAGE_SIZE, (n + 1) * PAGE_SIZE), n, newest.length > (n + 1) * PAGE_SIZE));
    }],
    [/^\/accounts\/([A-Za-z0-9_-]{1,40})$/, async ({ page, params }) => {
      const account = (await deps.accounts.listAccounts()).find((a) => a.id === params[0]);
      if (!account) return notFound(page);
      return html(200, accountPage(page, account, await deps.accounts.listKeys({ accountId: account.id })));
    }],
    [/^\/accounts\/([A-Za-z0-9_-]{1,40})\/disable\/confirm$/, async ({ page, params }) => {
      const account = (await deps.accounts.listAccounts()).find((a) => a.id === params[0]);
      if (!account) return notFound(page);
      return html(200, confirmPage(page, {
        title: `Disable ${account.name}?`, text: `All ${account.keyCount} keys of this account stop working within a minute. This cannot be undone here.`,
        action: `/accounts/${account.id}/disable`, button: "Disable account", danger: true, cancel: `/accounts/${account.id}`,
      }));
    }],
    [/^\/keys$/, async ({ page, url }) => {
      const n = pageNumber(url);
      const all = [...(await deps.accounts.listKeys())].reverse();
      return html(200, keysPage(page, all.slice(n * PAGE_SIZE, (n + 1) * PAGE_SIZE), n, all.length > (n + 1) * PAGE_SIZE));
    }],
    [/^\/keys\/([A-Za-z0-9_-]{12})$/, async ({ page, params }) => {
      const key = (await deps.accounts.listKeys()).find((k) => k.id === params[0]);
      if (!key) return notFound(page);
      return html(200, keyPage(page, key, await deps.accounts.keyUsage(key.id, { days: 30 })));
    }],
    [/^\/keys\/([A-Za-z0-9_-]{12})\/revoke\/confirm$/, async ({ page, params }) => {
      const key = (await deps.accounts.listKeys()).find((k) => k.id === params[0]);
      if (!key) return notFound(page);
      return html(200, confirmPage(page, {
        title: `Revoke ${key.display}?`, text: "The API refuses this key within a minute. Revoking is final.",
        action: `/keys/${key.id}/revoke`, button: "Revoke key", danger: true, cancel: `/keys/${key.id}`,
      }));
    }],
    [/^\/releases$/, async ({ page, url }) => {
      const n = pageNumber(url);
      const list = await releases(deps.sql, { page: n, now: clock() });
      return html(200, releasesPage(page, list, await listRequests(deps.sql, { limit: 20 }), n, list.length === PAGE_SIZE, clock()));
    }],
    [/^\/releases\/([fd][0-9T]{8,11})\/confirm$/, async ({ page, params }) => {
      const release = await releaseOf(deps.sql, params[0]!);
      if (!release) return notFound(page);
      if (release.status !== "held") return html(400, messagePageWith(page, "Not held", `Release ${release.version} is ${release.status}; only held releases are released here.`));
      return html(200, releaseConfirm(page, release.version, release.regressions, ""));
    }],
    [/^\/feeds$/, async ({ page }) => html(200, feedsPage(page, await feeds(deps.sql, clock()), clock()))],
    [/^\/feeds\/runs\/(\d{1,15})\/confirm$/, async ({ page, params }) => {
      const run = await runOf(deps.sql, Number(params[0]));
      if (!run) return notFound(page);
      return html(200, runConfirm(page, run.id, run.feedId, run.entryCount, run.previousEntryCount, ""));
    }],
    [/^\/audit$/, async ({ page }) => html(200, auditPage(page, await latestAudit(deps.sql, 100)))],
  ];

  const releaseConfirm = (page: PageSession, version: string, regressions: string[], note: string, error?: string) =>
    confirmPage(page, {
      title: `Release ${version}?`,
      text: `The release gate held this snapshot${regressions.length ? `: ${regressions.join("; ")}` : ""}. The scheduler publishes it within a minute with your note as the release note.`,
      action: `/releases/${version}/release`, button: "Request release", cancel: "/releases",
      fields: field("Why is this release fine? (10–1000 characters)", `<textarea name="note" minlength="10" maxlength="1000" required placeholder=" ">${escape(note)}</textarea>`),
      ...(error ? { error } : {}),
    });
  const runConfirm = (page: PageSession, id: number, feedId: string, entries: number | null, before: number | null, note: string, error?: string) =>
    confirmPage(page, {
      title: `Confirm run ${id} of ${feedId}?`,
      text: `The shrink guard held this run: ${entries ?? "?"} entries vs ${before ?? "?"} before. The scheduler applies it within a minute.`,
      action: `/feeds/runs/${id}/confirm`, button: "Request confirmation", cancel: "/feeds",
      fields: field("Note (optional)", `<textarea name="note" maxlength="1000" placeholder=" ">${escape(note)}</textarea>`),
      ...(error ? { error } : {}),
    });

  const posts: [RegExp, Handler][] = [
    [/^\/accounts$/, async ({ page, session, form }) => {
      try {
        const account = await deps.accounts.createAccount({ name: form.get("name") ?? "", contact: form.get("contact") ?? "" });
        await audit(deps.sql, { ...who(session), action: "account.create", item: account.id, details: { name: account.name } }, clock());
        return redirect(`/accounts/${account.id}`);
      } catch (error) {
        if (!(error instanceof ValidationError)) throw error;
        const all = [...(await deps.accounts.listAccounts())].reverse();
        return html(400, accountsPage(page, all.slice(0, PAGE_SIZE), 0, all.length > PAGE_SIZE, {
          name: form.get("name") ?? "", contact: form.get("contact") ?? "", error: error.message,
        }));
      }
    }],
    [/^\/accounts\/([A-Za-z0-9_-]{1,40})\/disable$/, async ({ session, params, page }) => {
      try {
        await deps.accounts.disableAccount(params[0]!);
      } catch (error) {
        if (error instanceof NotFoundError) return notFound(page);
        throw error;
      }
      await audit(deps.sql, { ...who(session), action: "account.disable", item: params[0]! }, clock());
      return redirect(`/accounts/${params[0]}`);
    }],
    [/^\/accounts\/([A-Za-z0-9_-]{1,40})\/keys$/, async ({ session, params, page, form }) => {
      const dailyQuota = optionalInt(form, "dailyQuota");
      const burst = optionalInt(form, "burst");
      const account = (await deps.accounts.listAccounts()).find((a) => a.id === params[0]);
      if (!account) return notFound(page);
      const keys = () => deps.accounts.listKeys({ accountId: account.id });
      if (dailyQuota === "invalid" || burst === "invalid") {
        return html(400, accountPage(page, account, await keys(), { label: form.get("label") ?? "", error: "Limits must be whole numbers." }));
      }
      try {
        const { key, info } = await deps.accounts.issueKey({ accountId: account.id, label: form.get("label") ?? "", dailyQuota, burst });
        await audit(deps.sql, { ...who(session), action: "key.issue", item: info.id, details: { accountId: account.id, label: info.label, dailyQuota, burst } }, clock());
        return html(200, secretPage(page, key, info));
      } catch (error) {
        if (!(error instanceof ValidationError)) throw error;
        return html(400, accountPage(page, account, await keys(), { label: form.get("label") ?? "", error: error.message }));
      }
    }],
    [/^\/keys\/([A-Za-z0-9_-]{12})\/limits$/, async ({ session, params, page, form }) => {
      const key = (await deps.accounts.listKeys()).find((k) => k.id === params[0]);
      if (!key) return notFound(page);
      const dailyQuota = optionalInt(form, "dailyQuota");
      const burst = optionalInt(form, "burst");
      const usage = () => deps.accounts.keyUsage(key.id, { days: 30 });
      if (dailyQuota === "invalid" || burst === "invalid") return html(400, keyPage(page, key, await usage(), { error: "Limits must be whole numbers." }));
      try {
        const next = await deps.accounts.setKeyLimits(key.id, { dailyQuota, burst });
        await audit(deps.sql, { ...who(session), action: "key.limits", item: key.id, details: { from: key.overrides, to: next.overrides } }, clock());
        return redirect(`/keys/${key.id}`);
      } catch (error) {
        if (!(error instanceof ValidationError)) throw error;
        return html(400, keyPage(page, key, await usage(), { error: error.message }));
      }
    }],
    [/^\/keys\/([A-Za-z0-9_-]{12})\/revoke$/, async ({ session, params, page }) => {
      try {
        await deps.accounts.revokeKey(params[0]!);
      } catch (error) {
        if (error instanceof NotFoundError) return notFound(page);
        throw error;
      }
      await audit(deps.sql, { ...who(session), action: "key.revoke", item: params[0]! }, clock());
      return redirect(`/keys/${params[0]}`);
    }],
    [/^\/releases\/([fd][0-9T]{8,11})\/release$/, async ({ session, params, page, form }) => {
      const note = form.get("note") ?? "";
      try {
        await requestRelease(deps.sql, { version: params[0]!, note, who: who(session) }, clock());
      } catch (error) {
        if (!(error instanceof RequestError)) throw error;
        const release = await releaseOf(deps.sql, params[0]!);
        return html(400, releaseConfirm(page, params[0]!, release?.regressions ?? [], note, error.message));
      }
      await audit(deps.sql, { ...who(session), action: "release.request", item: params[0]!, note: note.trim() }, clock());
      return redirect(`/releases#${params[0]}`);
    }],
    [/^\/feeds\/runs\/(\d{1,15})\/confirm$/, async ({ session, params, page, form }) => {
      const id = Number(params[0]);
      const note = form.get("note") ?? "";
      try {
        await requestRunConfirm(deps.sql, { runId: id, note, who: who(session) }, clock());
      } catch (error) {
        if (!(error instanceof RequestError)) throw error;
        const run = await runOf(deps.sql, id);
        return html(400, runConfirm(page, id, run?.feedId ?? "?", run?.entryCount ?? null, run?.previousEntryCount ?? null, note, error.message));
      }
      await audit(deps.sql, { ...who(session), action: "run.confirm.request", item: String(id), note: note.trim() || null }, clock());
      return redirect("/feeds");
    }],
  ];

  // --- Sign-in and the guard ----------------------------------------------------------------

  async function login(url: URL): Promise<Response> {
    let auth;
    try {
      auth = await deps.oidc.authorizationUrl();
    } catch (error) {
      log(`admin: sign-in unavailable: ${(error as Error).message}`);
      return html(503, messagePage("Sign-in unavailable", "foxauth cannot be reached right now. Try again in a minute.", false));
    }
    const headers = new Headers();
    headers.append("Set-Cookie", `${names.flow}=${sessions.signFlow(auth.flow, safeReturn(url.searchParams.get("return")))}; ${names.attrs}; Max-Age=600`);
    return redirect(auth.url, 302, headers);
  }

  async function callback(request: Request, url: URL): Promise<Response> {
    const headers = new Headers();
    headers.append("Set-Cookie", `${names.flow}=; ${names.attrs}; Max-Age=0`);
    const flow = sessions.readFlow(readCookie(request.headers.get("cookie"), names.flow));
    const failed = (reason: string) => {
      log(`admin: sign-in failed: ${reason}`);
      return html(400, messagePage("Sign-in failed", "The sign-in could not be completed."), headers);
    };
    if (!flow) return failed("no or expired flow cookie");
    let signed;
    try {
      signed = await deps.oidc.finish(url.searchParams, flow);
    } catch (error) {
      if (error instanceof OidcError) return failed(error.reason);
      return failed(`unexpected: ${(error as Error).message}`);
    }
    if (!signed.groups.some((g) => g.toLowerCase() === groupKey)) {
      await audit(deps.sql, { subject: signed.subject, name: signed.name, action: "session.denied" }, clock());
      return html(403, messagePage("Not allowed", "This account is not an operator of FoxTrust.", false), headers);
    }
    const id = await sessions.create({ subject: signed.subject, name: signed.name, idToken: signed.idToken });
    await audit(deps.sql, { subject: signed.subject, name: signed.name, action: "session.signin" }, clock());
    headers.append("Set-Cookie", `${names.session}=${id}; ${names.attrs}; Max-Age=${SESSION_HOURS * 3600}`);
    return redirect(flow.returnTo, 303, headers);
  }

  async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const asset = request.method === "GET" ? await assets.serve(path) : null;
    if (asset) return asset;
    if (request.method === "GET" && path === "/auth/login") return login(url);
    if (request.method === "GET" && path === "/auth/callback") return callback(request, url);

    const cookie = readCookie(request.headers.get("cookie"), names.session);
    const session = await sessions.find(cookie);
    if (request.method === "GET" || request.method === "HEAD") {
      if (!session) return redirect(`/auth/login?return=${encodeURIComponent(path + url.search)}`, 302);
      for (const [pattern, handler] of gets) {
        const m = pattern.exec(path);
        if (m) return handler({ request, url, params: m.slice(1), session, page: pageOf(session), form: new URLSearchParams() });
      }
      return notFound(pageOf(session));
    }
    if (request.method !== "POST") return html(405, messagePage("Not allowed", "This method is not supported.", false));
    if (!session) return html(401, messagePage("Signed out", "Your session has ended. Sign in again."));
    const body = await request.text();
    if (body.length > MAX_FORM) return html(413, messagePage("Too large", "The form is too large.", false));
    const form = new URLSearchParams(body);
    if (!postAllowed(request, origin, session.csrf, form)) {
      log("admin: refused a form post (origin or CSRF token)");
      return html(403, messagePage("Refused", "This request did not come from a page of this panel.", false));
    }
    if (path === "/auth/logout") {
      await sessions.end(cookie);
      const headers = new Headers();
      headers.append("Set-Cookie", `${names.session}=; ${names.attrs}; Max-Age=0`);
      return redirect((await deps.oidc.endSessionUrl(session.idToken, `${deps.url}/`)) ?? "/auth/login", 303, headers);
    }
    for (const [pattern, handler] of posts) {
      const m = pattern.exec(path);
      if (m) return handler({ request, url, params: m.slice(1), session, page: pageOf(session), form });
    }
    return notFound(pageOf(session));
  }

  const app = new Elysia()
    .get("/*", ({ request }) => handle(request))
    .get("/", ({ request }) => handle(request))
    .post("/*", ({ request }) => handle(request), { parse: "none" })
    .onError(({ error }) => {
      log(`admin: error: ${error instanceof Error ? error.message : "unknown"}`);
      return html(500, messagePage("Something went wrong", "The operation failed; see the panel log.", false));
    });
  return { app, handle };
}

export function startAdminServer(deps: AdminDeps & { port: number; hostname?: string }) {
  const { app } = createAdminApp(deps);
  app.listen({ port: deps.port, hostname: deps.hostname ?? "0.0.0.0" });
  return {
    port: app.server!.port as number,
    stop: async () => {
      await app.stop();
    },
  };
}
