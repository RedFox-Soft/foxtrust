import type { SQL } from "bun";
import { createOidc } from "../../src/admin/oidc";
import { startAdminServer } from "../../src/admin/server";
import { createAccounts, FREE_TIER, type Accounts } from "../../src/api/accounts";
import type { FakeOidc, FakeUser } from "./oidc";

export type TestAdmin = { url: string; logs: string[]; accounts: Accounts; stop: () => Promise<void> };

/** A free local port: the panel's own URL must be known before it starts (redirect URI, origin checks). */
async function freePort(): Promise<number> {
  const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
  const port = probe.port as number;
  await probe.stop(true);
  return port;
}

export async function startTestAdmin(opts: { sql: SQL; oidc: FakeOidc; clock?: () => Date; group?: string }): Promise<TestAdmin> {
  const logs: string[] = [];
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const clock = opts.clock ?? (() => new Date());
  const accounts = createAccounts(opts.sql, FREE_TIER, clock);
  const oidc = createOidc({ issuer: opts.oidc.issuer, clientId: opts.oidc.clientId, clientSecret: opts.oidc.clientSecret, redirectUri: `${url}/auth/callback` });
  const server = startAdminServer({
    sql: opts.sql, oidc, accounts, url, group: opts.group ?? "foxtrust-operators", clock, log: (l) => logs.push(l), port, hostname: "127.0.0.1",
  });
  return { url, logs, accounts, stop: server.stop };
}

/** A browser with a cookie jar, talking to one panel. */
export type Browser = {
  cookies: Map<string, string>;
  csrf: string;
  get: (path: string) => Promise<Response>;
  /** A form post from a page of the panel: adds `csrf` (unless given) and the panel's `Origin`. */
  post: (path: string, fields?: Record<string, string>, headers?: Record<string, string>) => Promise<Response>;
};

function keep(jar: Map<string, string>, res: Response) {
  for (const line of res.headers.getSetCookie()) {
    const [pair, ...attrs] = line.split(";");
    const eq = pair!.indexOf("=");
    const name = pair!.slice(0, eq).trim();
    const value = pair!.slice(eq + 1).trim();
    if (attrs.some((a) => a.trim().toLowerCase() === "max-age=0") || value === "") jar.delete(name);
    else jar.set(name, value);
  }
}

export function browser(admin: TestAdmin, jar = new Map<string, string>()): Browser {
  const cookieHeader = () => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
  const b: Browser = {
    cookies: jar,
    csrf: "",
    get: async (path) => {
      const res = await fetch(`${admin.url}${path}`, { headers: { Cookie: cookieHeader() }, redirect: "manual" });
      keep(jar, res);
      return res;
    },
    post: async (path, fields = {}, headers = {}) => {
      const body = new URLSearchParams({ csrf: b.csrf, ...fields }).toString();
      const res = await fetch(`${admin.url}${path}`, {
        method: "POST", redirect: "manual", body,
        headers: { Cookie: cookieHeader(), Origin: admin.url, "Content-Type": "application/x-www-form-urlencoded", ...headers },
      });
      keep(jar, res);
      return res;
    },
  };
  return b;
}

export type SignIn = { status: number; html: string; headers: Headers; location: string | null; browser: Browser };

/** The whole sign-in: panel login → provider /auth → panel callback; returns where it ended. */
export async function signIn(admin: TestAdmin, oidc: FakeOidc, user?: FakeUser, returnTo = "/"): Promise<SignIn> {
  if (user) oidc.nextUser(user);
  const b = browser(admin);
  const login = await b.get(`/auth/login?return=${encodeURIComponent(returnTo)}`);
  if (login.status !== 302) return { status: login.status, html: await login.text(), headers: login.headers, location: null, browser: b };
  const auth = await fetch(login.headers.get("location")!, { redirect: "manual" });
  const callback = new URL(auth.headers.get("location")!);
  const done = await b.get(`${callback.pathname}${callback.search}`);
  const result = { status: done.status, html: await done.text(), headers: done.headers, location: done.headers.get("location"), browser: b };
  if (done.status === 303) b.csrf = csrfOf(await (await b.get("/")).text());
  return result;
}

/** The CSRF token from any signed-in page (the sign-out form carries it). */
export function csrfOf(html: string): string {
  return /name="csrf" value="([^"]+)"/.exec(html)?.[1] ?? "";
}

/** The first match of `pattern` in a page, e.g. a link or a hidden field. */
export const find = (html: string, pattern: RegExp) => pattern.exec(html)?.[1] ?? null;
