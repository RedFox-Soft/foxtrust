import { afterAll, beforeAll, expect, test } from "bun:test";
import { browser, csrfOf, find, signIn, startTestAdmin, type TestAdmin } from "../helpers/admin";
import { testClock } from "../helpers/api";
import { describeDb, withTestDb } from "../helpers/db";
import { startFakeOidc, type FakeOidc } from "../helpers/oidc";

const OPERATOR = { sub: "operator-1", name: "Test Operator", groups: ["foxtrust-operators"] };

describeDb("US4 (spec 011): only the operator gets in, and every change is recorded", () => {
  const db = withTestDb();
  const clock = testClock();
  let oidc: FakeOidc;
  let admin: TestAdmin;

  beforeAll(async () => {
    oidc = await startFakeOidc();
    admin = await startTestAdmin({ sql: db.sql, oidc, clock: clock.now });
  });

  afterAll(async () => {
    await admin?.stop();
    await oidc?.stop();
  });

  const count = async (table: "account" | "admin_session") =>
    ((await db.sql.unsafe(`SELECT count(*)::int AS n FROM ${table}`)) as { n: number }[])[0]!.n;

  test("US4-1: without a session a page sends the visitor to sign in, and back to the page after it", async () => {
    const res = await browser(admin).get("/keys");
    expect([res.status, res.headers.get("location")]).toEqual([302, "/auth/login?return=%2Fkeys"]);
    const signed = await signIn(admin, oidc, OPERATOR, "/keys");
    expect([signed.status, signed.location]).toEqual([303, "/keys"]);
    expect((await signed.browser.get("/keys")).status).toBe(200);
  });

  test("US4-2: an account outside the operator group is not let in; the group is matched without case, also through userinfo", async () => {
    const sessionsBefore = await count("admin_session");
    for (const user of [{ sub: "customer-1", name: "A Customer", groups: ["customers"] }, { sub: "nobody-1", name: "No Groups" }]) {
      const r = await signIn(admin, oidc, user);
      expect({ sub: user.sub, status: r.status, cookie: r.browser.cookies.has("foxtrust_admin") }).toEqual({ sub: user.sub, status: 403, cookie: false });
      expect(r.html).toContain("not an operator");
      expect(r.html).not.toContain("<nav>");
    }
    expect(await count("admin_session")).toBe(sessionsBefore);
    const denied = (await db.sql`SELECT subject FROM admin_audit WHERE action = 'session.denied'`) as { subject: string }[];
    expect(denied.map((d) => d.subject).sort()).toEqual(["customer-1", "nobody-1"]);

    for (const user of [
      { sub: "operator-2", name: "Upper Case", groups: ["FoxTrust-Operators"] },
      { sub: "operator-3", name: "Many Groups", groups: ["foxtrust-operators"], distributed: true },
    ]) {
      const r = await signIn(admin, oidc, user);
      expect({ sub: user.sub, status: r.status }).toEqual({ sub: user.sub, status: 303 });
    }
  });

  test("US4-3: every change has an audit record with the operator, newest first, never the key secret", async () => {
    const op = (await signIn(admin, oidc, OPERATOR)).browser;
    const created = await op.post("/accounts", { name: "Audited customer", contact: "ops@audited.example" });
    const accountId = created.headers.get("location")!.split("/").at(-1)!;
    const issued = await (await op.post(`/accounts/${accountId}/keys`, { label: "audit" })).text();
    const key = find(issued, /(ftk_[A-Za-z0-9_-]{12}_[A-Za-z0-9_-]{43})/)!;
    expect((await op.post(`/keys/${key.slice(4, 16)}/revoke`)).status).toBe(303);

    const page = await (await op.get("/audit")).text();
    const actions = [...page.matchAll(/<td>([a-z.]+)<\/td><td>/g)].map((m) => m[1]);
    expect(actions.slice(0, 3)).toEqual(["key.revoke", "key.issue", "account.create"]);
    expect(page).toContain("Test Operator");
    const rows = JSON.stringify(await db.sql`SELECT * FROM admin_audit`);
    expect(rows.includes(key.slice(17))).toBe(false);
    expect(page.includes(key.slice(17))).toBe(false);
  });

  test("US4-4: a form post from another origin, without the token or with another session's token changes nothing", async () => {
    const op = (await signIn(admin, oidc, OPERATOR)).browser;
    const other = (await signIn(admin, oidc, { ...OPERATOR, sub: "operator-4" })).browser;
    const before = await count("account");
    const fields = { name: "Should not exist", contact: "x@example.com" };
    const attempts = [
      await op.post("/accounts", fields, { Origin: "https://evil.example" }),
      await op.post("/accounts", { ...fields, csrf: "" }),
      await op.post("/accounts", { ...fields, csrf: other.csrf }),
      await op.post("/accounts", fields, { "Sec-Fetch-Site": "cross-site" }),
    ];
    expect(attempts.map((r) => r.status)).toEqual([403, 403, 403, 403]);
    expect(await count("account")).toBe(before);
    expect(csrfOf(await (await op.get("/")).text())).toBe(op.csrf);
  });

  test("US4-5: a session ends after its lifetime or at sign-out, and sign-out goes on to foxauth", async () => {
    const aged = (await signIn(admin, oidc, OPERATOR)).browser;
    clock.advance(8 * 3_600_000 + 60_000);
    try {
      const res = await aged.get("/");
      expect([res.status, res.headers.get("location")]).toEqual([302, "/auth/login?return=%2F"]);
    } finally {
      clock.set(new Date());
    }

    const op = (await signIn(admin, oidc, OPERATOR)).browser;
    const cookie = op.cookies.get("foxtrust_admin")!;
    const out = await op.post("/auth/logout");
    const location = new URL(out.headers.get("location")!);
    expect(out.status).toBe(303);
    expect(`${location.origin}${location.pathname}`).toBe(`${oidc.issuer}/logout`);
    expect(location.searchParams.get("id_token_hint")).toBe(oidc.issued.at(-1)!);
    expect(location.searchParams.get("post_logout_redirect_uri")).toBe(`${admin.url}/`);
    const stale = browser(admin, new Map([["foxtrust_admin", cookie]]));
    expect((await stale.get("/")).status).toBe(302);
  });
});
