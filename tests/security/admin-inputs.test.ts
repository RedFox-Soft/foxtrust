import { afterAll, beforeAll, expect, test } from "bun:test";
import { browser, find, signIn, startTestAdmin, type TestAdmin } from "../helpers/admin";
import { describeDb, withTestDb } from "../helpers/db";
import { startFakeOidc, type FakeOidc, type Forge } from "../helpers/oidc";

const OPERATOR = { sub: "operator-1", name: "Test Operator", groups: ["foxtrust-operators"] };
const HEADERS = {
  "content-security-policy": "default-src 'none'; style-src 'self'; font-src 'self'; img-src 'self' data:; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  "x-frame-options": "DENY",
  "cache-control": "no-store",
};

describeDb("SEC (spec 011): admin panel inputs", () => {
  const db = withTestDb();
  let oidc: FakeOidc;
  let admin: TestAdmin;

  beforeAll(async () => {
    oidc = await startFakeOidc();
    admin = await startTestAdmin({ sql: db.sql, oidc });
  });

  afterAll(async () => {
    await admin?.stop();
    await oidc?.stop();
  });

  const sessions = async () => ((await db.sql`SELECT count(*)::int AS n FROM admin_session`) as { n: number }[])[0]!.n;

  test("SEC: forged or mismatched ID tokens never create a session", async () => {
    const before = await sessions();
    const forgeries: Forge[] = [{ otherKey: true }, { alg: "HS256" }, { alg: "none" }, { aud: "another-client" }, { iss: "https://evil.example" }, { expired: true }, { nonce: "not-the-nonce" }];
    for (const forge of forgeries) {
      oidc.forge(forge);
      const r = await signIn(admin, oidc, OPERATOR);
      expect({ forge, status: r.status, cookie: r.browser.cookies.has("foxtrust_admin") }).toEqual({ forge, status: 400, cookie: false });
    }

    oidc.wrongIss();
    expect((await signIn(admin, oidc, OPERATOR)).status).toBe(400);

    // A state that is not the one this browser started with.
    const b = browser(admin);
    const login = await b.get("/auth/login");
    const auth = await fetch(login.headers.get("location")!, { redirect: "manual" });
    const callback = new URL(auth.headers.get("location")!);
    callback.searchParams.set("state", "tampered");
    expect((await b.get(`${callback.pathname}${callback.search}`)).status).toBe(400);

    // A code used twice: the second exchange fails at the provider.
    const c = browser(admin);
    const login2 = await c.get("/auth/login");
    const flowCookie = new Map(c.cookies);
    const auth2 = await fetch(login2.headers.get("location")!, { redirect: "manual" });
    const back = new URL(auth2.headers.get("location")!);
    expect((await c.get(`${back.pathname}${back.search}`)).status).toBe(303);
    const replay = browser(admin, flowCookie);
    const again = await replay.get(`${back.pathname}${back.search}`);
    expect([again.status, replay.cookies.has("foxtrust_admin")]).toEqual([400, false]);

    expect(await sessions()).toBe(before + 1);
    expect(admin.logs.some((l) => l.includes("sign-in failed"))).toBe(true);
  });

  test("SEC: the return path cannot leave the panel", async () => {
    for (const target of ["https://evil.example/x", "//evil.example", "/\\evil.example", "javascript:alert(1)"]) {
      const r = await signIn(admin, oidc, OPERATOR, target);
      expect({ target, location: r.location }).toEqual({ target, location: "/" });
    }
  });

  test("SEC: every page forbids framing and carries no script", async () => {
    const op = (await signIn(admin, oidc, OPERATOR)).browser;
    const created = await op.post("/accounts", { name: "Headers", contact: "h@example.com" });
    const accountId = created.headers.get("location")!.split("/").at(-1)!;
    const pages: [string, Headers, string][] = [];
    for (const res of [
      await op.get("/"), await op.get("/keys"), await op.get("/audit"), await op.get("/no-such-page"),
      await op.post(`/accounts/${accountId}/keys`, { label: "secret page" }),
      await fetch(`${admin.url}/auth/callback?state=x&code=y`),
    ]) pages.push([`${res.status} ${res.url}`, res.headers, await res.text()]);
    const denied = await signIn(admin, oidc, { sub: "x", name: "Not operator", groups: [] });
    pages.push([`${denied.status} not allowed`, denied.headers, denied.html]);
    expect(pages.map(([page]) => page.split(" ")[0])).toEqual(["200", "200", "200", "404", "200", "400", "403"]);
    for (const [page, headers, html] of pages) {
      for (const [name, value] of Object.entries(HEADERS)) expect({ page, name, value: headers.get(name) }).toEqual({ page, name, value });
      expect({ page, script: html.toLowerCase().includes("<script") }).toEqual({ page, script: false });
    }
  });

  test("SEC: no secret reaches logs, audit or the session table", async () => {
    const signed = await signIn(admin, oidc, OPERATOR);
    const op = signed.browser;
    const cookie = op.cookies.get("foxtrust_admin")!;
    const created = await op.post("/accounts", { name: "Secrets", contact: "s@example.com" });
    const accountId = created.headers.get("location")!.split("/").at(-1)!;
    const key = find(await (await op.post(`/accounts/${accountId}/keys`, { label: "s" })).text(), /(ftk_[A-Za-z0-9_-]{12}_[A-Za-z0-9_-]{43})/)!;
    oidc.forge({ otherKey: true });
    await signIn(admin, oidc, OPERATOR);

    const audit = JSON.stringify(await db.sql`SELECT * FROM admin_audit`);
    const sessionTable = JSON.stringify(await db.sql`SELECT encode(id_sha256, 'hex') AS id, subject, name, csrf FROM admin_session`);
    const secrets = [oidc.clientSecret, key.slice(17), cookie, ...oidc.issued];
    for (const secret of secrets) {
      for (const [where, text] of [["logs", admin.logs.join("\n")], ["audit", audit]] as const) {
        expect({ where, leaked: text.includes(secret) }).toEqual({ where, leaked: false });
      }
    }
    expect(sessionTable.includes(cookie)).toBe(false);
    expect(sessionTable).toContain(new Bun.CryptoHasher("sha256").update(cookie).digest("hex"));
  });

  test("SEC: actions need a session", async () => {
    const op = (await signIn(admin, oidc, OPERATOR)).browser;
    const created = await op.post("/accounts", { name: "Target", contact: "t@example.com" });
    const accountId = created.headers.get("location")!.split("/").at(-1)!;
    const before = JSON.stringify(await db.sql`SELECT * FROM account ORDER BY id`);
    const anonymous = browser(admin);
    anonymous.csrf = op.csrf;
    for (const path of [
      "/accounts", `/accounts/${accountId}/disable`, `/accounts/${accountId}/keys`, "/keys/AAAAAAAAAAAA/limits", "/keys/AAAAAAAAAAAA/revoke",
      "/releases/f20261007/release", "/feeds/runs/1/confirm", "/auth/logout",
    ]) {
      const res = await anonymous.post(path, { name: "x", contact: "y", note: "long enough note here" });
      expect({ path, status: res.status }).toEqual({ path, status: 401 });
    }
    expect(JSON.stringify(await db.sql`SELECT * FROM account ORDER BY id`)).toBe(before);
    expect(((await db.sql`SELECT count(*)::int AS n FROM operator_request`) as { n: number }[])[0]!.n).toBe(0);
  });
});
