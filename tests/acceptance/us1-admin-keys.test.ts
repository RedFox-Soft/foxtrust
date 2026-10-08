import { afterAll, beforeAll, expect, test } from "bun:test";
import { hashSecret } from "../../src/api/key";
import { find, signIn, startTestAdmin, type Browser, type TestAdmin } from "../helpers/admin";
import { bearer, startTestApi, type TestApi } from "../helpers/api";
import { describeDb, withTestDb } from "../helpers/db";
import { startFakeOidc, type FakeOidc } from "../helpers/oidc";
import { createTestPublication, type TestPublication } from "../helpers/publication";
import { ADDR, publishRecordedSnapshot } from "../helpers/verify";

const KEY = /(ftk_[A-Za-z0-9_-]{12}_[A-Za-z0-9_-]{43})/;

describeDb("US1 (spec 011): the operator manages customers' keys", () => {
  const db = withTestDb();
  let oidc: FakeOidc;
  let admin: TestAdmin;
  let pub: TestPublication;
  let api: TestApi;
  let op: Browser;

  beforeAll(async () => {
    oidc = await startFakeOidc();
    admin = await startTestAdmin({ sql: db.sql, oidc });
    pub = await createTestPublication();
    await publishRecordedSnapshot(pub);
    api = await startTestApi({ pub, sql: db.sql });
    op = (await signIn(admin, oidc)).browser;
  });

  afterAll(async () => {
    await api?.stop();
    await pub?.stop();
    await admin?.stop();
    await oidc?.stop();
  });

  /** Creates an account through the panel and issues one key; returns the ids and the full key. */
  async function issue(label: string, account?: string) {
    let accountId = account;
    if (!accountId) {
      const created = await op.post("/accounts", { name: `Customer ${label}`, contact: "ops@customer.example" });
      expect(created.status).toBe(303);
      accountId = created.headers.get("location")!.split("/").at(-1)!;
    }
    const res = await op.post(`/accounts/${accountId}/keys`, { label, dailyQuota: "", burst: "" });
    const html = await res.text();
    const key = find(html, KEY)!;
    return { res, html, key, id: key.slice(4, 16), secret: key.slice(17), accountId };
  }
  const lookup = (key: string) => api.get(`/v1/ip/${ADDR.low[4]}`, bearer(key));

  test("US1-1: a new key is shown once, on the answer to its creation, and only its hash is stored", async () => {
    const { res, key, id, secret, accountId } = await issue("prod");
    expect(res.status).toBe(200);
    expect(key).toMatch(KEY);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    for (const path of ["/keys", `/keys/${id}`, `/accounts/${accountId}`, "/audit", "/"]) {
      const page = await (await op.get(path)).text();
      expect({ path, shown: page.includes(secret) }).toEqual({ path, shown: false });
      if (path !== "/" && path !== "/audit") expect(page).toContain(`ftk_${id}_…`);
    }
    const [row] = (await db.sql`SELECT secret_sha256 FROM api_key WHERE id = ${id}`) as { secret_sha256: Uint8Array }[];
    expect(new Uint8Array(row!.secret_sha256)).toEqual(new Uint8Array(hashSecret(secret)));
  });

  test("US1-2: the key list and a key's page show limits, times and usage", async () => {
    const { key, id } = await issue("staging");
    await api.reload();
    for (let i = 0; i < 3; i++) expect((await lookup(key)).status).toBe(200);
    await api.flush();
    const list = await (await op.get("/keys")).text();
    const row = list.split("<tr>").find((r) => r.includes(`ftk_${id}_…`))!;
    for (const text of ["staging", "free", "1000/day, 5/s", "active", "<td>3</td>"]) expect({ text, found: row.includes(text) }).toEqual({ text, found: true });
    const page = await (await op.get(`/keys/${id}`)).text();
    const today = new Date().toISOString().slice(0, 10);
    expect(page).toMatch(new RegExp(`<td>${today}</td><td>3</td><td>0</td><td>0</td>`));
    expect(page).not.toContain("last used —");
  });

  test("US1-3: changed limits are shown and the API follows them; empty fields restore the defaults", async () => {
    const { key, id } = await issue("limited");
    const set = await op.post(`/keys/${id}/limits`, { dailyQuota: "2", burst: "" });
    expect([set.status, set.headers.get("location")]).toEqual([303, `/keys/${id}`]);
    expect(await (await op.get(`/keys/${id}`)).text()).toContain("Limits: 2/day, 5/s (default)");
    await api.reload();
    const statuses = [];
    for (let i = 0; i < 3; i++) statuses.push((await lookup(key)).status);
    expect(statuses).toEqual([200, 200, 429]);

    expect((await op.post(`/keys/${id}/limits`, { dailyQuota: "", burst: "" })).status).toBe(303);
    expect(await (await op.get(`/keys/${id}`)).text()).toContain("Limits: 1000/day (default), 5/s (default)");
    await api.reload();
    expect((await lookup(key)).status).toBe(200);
  });

  test("US1-4: revoking a key or disabling an account asks first, stops the API within a reload, and is audited", async () => {
    const one = await issue("leaked");
    const confirm = await (await op.get(`/keys/${one.id}/revoke/confirm`)).text();
    expect(confirm).toContain(`action="/keys/${one.id}/revoke"`);
    expect((await op.post(`/keys/${one.id}/revoke`)).status).toBe(303);
    expect(await (await op.get(`/keys/${one.id}`)).text()).toContain("status-revoked");
    await api.reload();
    expect((await lookup(one.key)).status).toBe(401);

    const first = await issue("a");
    const second = await issue("b", first.accountId);
    await api.reload();
    expect((await lookup(second.key)).status).toBe(200);
    expect(await (await op.get(`/accounts/${first.accountId}/disable/confirm`)).text()).toContain(`action="/accounts/${first.accountId}/disable"`);
    expect((await op.post(`/accounts/${first.accountId}/disable`)).status).toBe(303);
    await api.reload();
    for (const key of [first.key, second.key]) expect((await lookup(key)).status).toBe(401);

    const actions = (await db.sql`SELECT action, item, subject FROM admin_audit`) as { action: string; item: string | null; subject: string }[];
    for (const [action, item] of [
      ["account.create", first.accountId], ["key.issue", one.id], ["key.revoke", one.id], ["account.disable", first.accountId],
    ] as const) {
      expect({ action, item, found: actions.some((a) => a.action === action && a.item === item && a.subject === "operator-1") }).toEqual({ action, item, found: true });
    }
    expect(actions.some((a) => a.action === "key.limits")).toBe(true);
  });
});
