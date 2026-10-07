import { afterAll, beforeAll, expect, test } from "bun:test";
import { bearer, issueTestKey, startTestApi, type TestApi } from "../helpers/api";
import { describeDb, withTestDb } from "../helpers/db";
import { createTestPublication, type TestPublication } from "../helpers/publication";
import { ADDR, publishRecordedSnapshot } from "../helpers/verify";

describeDb("SEC (spec 010): public API inputs", () => {
  const db = withTestDb();
  let pub: TestPublication;
  let api: TestApi;

  beforeAll(async () => {
    pub = await createTestPublication();
    await publishRecordedSnapshot(pub);
    api = await startTestApi({ pub, sql: db.sql });
  });

  afterAll(async () => {
    await api?.stop();
    await pub?.stop();
  });

  const errorCode = async (res: Response) => ((await res.json()) as { error?: { code: string } }).error?.code;

  test("SEC: a key in the query string is refused before it is checked", async () => {
    const { key, id } = await issueTestKey(api, { burst: 100 });
    for (const name of ["key", "api_key", "apikey"]) {
      const res = await api.get(`/v1/ip/${ADDR.high[4]}?${name}=${encodeURIComponent(key)}`, bearer(key));
      expect({ name, status: res.status, code: await errorCode(res) }).toEqual({ name, status: 400, code: "key_in_query" });
      expect(res.headers.get("X-RateLimit-Remaining")).toBeNull();
    }
    await api.flush();
    expect(await api.accounts.keyUsage(id, { days: 1 })).toEqual([]);
  });

  test("SEC: no key secret is stored or logged", async () => {
    const { key } = await issueTestKey(api, { burst: 100 });
    const secret = key.split("_").at(-1)!;
    await api.get(`/v1/ip/${ADDR.high[4]}`, bearer(key));
    await api.get(`/v1/ip/${ADDR.high[4]}?key=${key}`);
    await api.flush();
    api.summarize();
    const encode = (_k: string, v: unknown) => (v instanceof Uint8Array ? Buffer.from(v).toString("hex") : v);
    const dump = JSON.stringify({
      accounts: await db.sql`SELECT * FROM account`,
      keys: await db.sql`SELECT * FROM api_key`,
      usage: await db.sql`SELECT * FROM api_usage_daily`,
      listed: await api.accounts.listKeys(),
    }, encode);
    for (const text of [dump, ...api.logs]) expect(text.includes(secret)).toBe(false);
  });

  test("SEC: revoked keys and disabled accounts get no verdict, in any answer", async () => {
    const revoked = await issueTestKey(api, { burst: 100 });
    const disabled = await issueTestKey(api, { burst: 100 });
    await api.accounts.revokeKey(revoked.id);
    await api.accounts.disableAccount(disabled.accountId);
    await api.reload();
    for (const key of [revoked.key, disabled.key]) {
      for (const path of [`/v1/ip/${ADDR.high[4]}`, "/v1/ip/not-an-ip"]) {
        const res = await api.get(path, bearer(key));
        const body = (await res.json()) as Record<string, unknown>;
        expect({ path, status: res.status, risk: body.risk, reasons: body.reasons }).toEqual({ path, status: 401, risk: undefined, reasons: undefined });
      }
    }
    // A disabled account cannot get a new key either.
    const refused = await api.accounts.issueKey({ accountId: disabled.accountId }).then(() => null, (error: Error) => error.message);
    expect(refused).toContain("disabled");
  });

  test("SEC: malformed keys and over-long addresses cost no database work", async () => {
    const { key } = await issueTestKey(api, { burst: 100 });
    // The key set is the only path from a request to the database; requests must never reload it.
    const reloadedAt = api.keys.status().lastReloadAt;
    const statuses = [];
    for (const header of [`Bearer ${"x".repeat(5000)}`, "Bearer ftk_", "Basic abc", `Bearer ftk_${"A".repeat(12)}_${"B".repeat(43)}`]) {
      statuses.push((await api.get(`/v1/ip/${ADDR.high[4]}`, { Authorization: header })).status);
    }
    expect(statuses).toEqual([401, 401, 401, 401]);
    const long = await api.get(`/v1/ip/${"1".repeat(46)}`, bearer(key));
    expect([long.status, await errorCode(long)]).toEqual([400, "invalid_ip"]);
    expect(api.keys.status().lastReloadAt).toBe(reloadedAt);
  });

  test("SEC: /status reveals no key ids, accounts or per-key counts", async () => {
    const { id, accountId } = await issueTestKey(api, { burst: 100 });
    const res = await api.get("/status");
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(text.includes(id)).toBe(false);
    expect(text.includes(accountId)).toBe(false);
    expect(Object.keys(JSON.parse(text) as object).sort()).toEqual(["ageSeconds", "builtAt", "deltaVersion", "keys", "snapshotVersion", "stale", "usage"]);
  });
});
