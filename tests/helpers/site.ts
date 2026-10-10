import type { SQL } from "bun";
import { createAccounts, type Accounts } from "../../src/api/accounts";
import { readSiteConfig } from "../../src/site/config";
import { contentValues, loadContent } from "../../src/site/content";
import { startSiteServer } from "../../src/site/server";
import { createOidc } from "../../src/web/oidc";
import { browser, csrfOf, type Browser } from "./admin";
import type { FakeOidc, FakeUser } from "./oidc";

export type TestSite = { url: string; logs: string[]; accounts: Accounts | null; stop: () => Promise<void> };

/** A free local port: the site's own URL must be known before it starts (redirect URI, origin checks). */
async function freePort(): Promise<number> {
  const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
  const port = probe.port as number;
  await probe.stop(true);
  return port;
}

/**
 * Starts the site on 127.0.0.1. Public-only without `oidc`; with it, sign-in goes to the fake
 * provider and accounts live in `sql`. `env` adds settings (limits, trusted keys, URLs).
 */
export async function startTestSite(opts: {
  sql?: SQL;
  oidc?: FakeOidc;
  clock?: () => Date;
  env?: Record<string, string>;
  contentDir?: string;
} = {}): Promise<TestSite> {
  const logs: string[] = [];
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const clock = opts.clock ?? (() => new Date());
  const env: Record<string, string> = { FOXTRUST_SITE_URL: url, ...opts.env };
  if (opts.oidc) {
    Object.assign(env, {
      FOXTRUST_SITE_ISSUER: opts.oidc.issuer, FOXTRUST_SITE_CLIENT_ID: opts.oidc.clientId, FOXTRUST_SITE_CLIENT_SECRET: opts.oidc.clientSecret,
      FOXTRUST_SITE_CONTACT: "operator@example.com", DATABASE_URL: "postgres://unused", ...opts.env,
    });
  }
  const config = readSiteConfig(env, { allowHttpIssuer: true });
  const content = await loadContent({ values: contentValues(config), ...(opts.contentDir ? { dir: opts.contentDir } : {}) });
  let accounts: Accounts | null = null;
  let signIn = null;
  if (opts.oidc && config.signIn) {
    if (!opts.sql) throw new Error("startTestSite: sign-in needs sql");
    accounts = createAccounts(opts.sql, config.free, clock);
    const oidc = createOidc({
      issuer: opts.oidc.issuer, clientId: opts.oidc.clientId, clientSecret: opts.oidc.clientSecret, redirectUri: `${url}/auth/callback`, scope: "openid profile email",
    });
    signIn = {
      sql: opts.sql, oidc, accounts, issuer: config.signIn.issuer, contact: config.signIn.contact, maxKeys: config.maxKeys, keysPerDay: config.keysPerDay,
    };
  }
  const server = startSiteServer({ url, content, signIn, clock, log: (l) => logs.push(l), port, hostname: "127.0.0.1" });
  return { url, logs, accounts, stop: server.stop };
}

export type SiteSignIn = { status: number; html: string; headers: Headers; location: string | null; browser: Browser };

/** The whole sign-in: site login → provider /auth → site callback; returns where it ended. */
export async function signInSite(site: TestSite, oidc: FakeOidc, user?: FakeUser, returnTo = "/account"): Promise<SiteSignIn> {
  if (user) oidc.nextUser(user);
  const b = browser(site);
  const login = await b.get(`/auth/login?return=${encodeURIComponent(returnTo)}`);
  if (login.status !== 302) return { status: login.status, html: await login.text(), headers: login.headers, location: null, browser: b };
  const auth = await fetch(login.headers.get("location")!, { redirect: "manual" });
  const callback = new URL(auth.headers.get("location")!);
  const done = await b.get(`${callback.pathname}${callback.search}`);
  const result = { status: done.status, html: await done.text(), headers: done.headers, location: done.headers.get("location"), browser: b };
  if (done.status === 303) b.csrf = csrfOf(await (await b.get("/account")).text());
  return result;
}
