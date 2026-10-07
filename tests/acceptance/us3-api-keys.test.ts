import { afterAll, beforeAll, expect, test } from "bun:test";
import { hashSecret } from "../../src/api/key";
import { bearer, issueTestKey, startTestApi, testClock, type TestApi } from "../helpers/api";
import { describeDb, withTestDb } from "../helpers/db";
import { createTestPublication, type TestPublication } from "../helpers/publication";
import { ADDR, publishRecordedSnapshot } from "../helpers/verify";

describeDb("US3 (spec 010): key changes reach the API within a minute", () => {
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

  const lookup = (key: string, target = api) => target.get(`/v1/ip/${ADDR.low[4]}`, bearer(key));

  test("US3-1: a new key is returned once, and only a hash of its secret is stored", async () => {
    const account = await api.accounts.createAccount({ name: "Acme", contact: "security@acme.example" });
    const { key, info } = await api.accounts.issueKey({ accountId: account.id, label: "prod" });
    const match = /^ftk_([A-Za-z0-9_-]{12})_([A-Za-z0-9_-]{43})$/.exec(key)!;
    expect(match[1]).toBe(info.id);
    const [row] = (await db.sql`SELECT * FROM api_key WHERE id = ${info.id}`) as Record<string, unknown>[];
    expect(new Uint8Array(row!.secret_sha256 as Uint8Array)).toEqual(new Uint8Array(hashSecret(match[2]!)));
    const stored = JSON.stringify(row, (_k, v: unknown) => (v instanceof Uint8Array ? Buffer.from(v).toString("base64url") : v));
    expect(stored).not.toContain(match[2]!);
    expect(JSON.stringify(info)).not.toContain(match[2]!);
  });

  test("US3-2: listed keys show account, label, tier, limits, times and usage, never the secret", async () => {
    const { key, id, accountId } = await issueTestKey(api, { label: "staging", burst: 100 });
    for (let i = 0; i < 3; i++) expect((await lookup(key)).status).toBe(200);
    await api.flush();
    const info = (await api.accounts.listKeys({ accountId })).find((k) => k.id === id)!;
    expect(info).toMatchObject({
      display: `ftk_${id}_…`, accountId, label: "staging", tier: "free", dailyQuota: 1000, burst: 100,
      answeredToday: 3, answeredLast7Days: 3, revokedAt: null,
    });
    expect(info.createdAt).toBeInstanceOf(Date);
    expect(info.lastUsedAt).toBeInstanceOf(Date);
    const listed = JSON.stringify(await api.accounts.listKeys());
    expect(listed).not.toContain(key.split("_").at(-1)!);
    expect(listed).not.toContain("sha256");
  });

  test("US3-3: changed limits apply to the next lookups", async () => {
    const { key, id } = await issueTestKey(api, { burst: 100 });
    await api.accounts.setKeyLimits(id, { dailyQuota: 2 });
    await api.reload();
    const statuses = [];
    for (let i = 0; i < 3; i++) statuses.push((await lookup(key)).status);
    expect(statuses).toEqual([200, 200, 429]);

    await api.accounts.setKeyLimits(id, { dailyQuota: null });
    await api.reload();
    const res = await lookup(key);
    expect([res.status, res.headers.get("X-RateLimit-Limit")]).toEqual([200, "1000"]);
  });

  test("US3-4: a revoked key or a disabled account stops working within a minute; usage history stays", async () => {
    const one = await issueTestKey(api, { burst: 100 });
    expect((await lookup(one.key)).status).toBe(200);
    await api.flush();
    await api.accounts.revokeKey(one.id);
    await api.reload();
    expect((await lookup(one.key)).status).toBe(401);
    expect((await api.accounts.keyUsage(one.id, { days: 7 })).map((d) => d.answered)).toEqual([1]);

    const two = await issueTestKey(api, { burst: 100 });
    const second = await api.accounts.issueKey({ accountId: two.accountId, burst: 100 });
    await api.reload();
    expect((await lookup(second.key)).status).toBe(200);
    await api.accounts.disableAccount(two.accountId);
    await api.reload();
    for (const key of [two.key, second.key]) expect((await lookup(key)).status).toBe(401);

    // The key set's own timer, on a clock moved 31 s: no explicit reload.
    const clock = testClock();
    const timed = await startTestApi({ pub, sql: db.sql, clock: clock.now });
    const stopTimer = timed.startKeyTimer(20);
    try {
      const three = await issueTestKey(timed, { burst: 100 });
      expect((await lookup(three.key, timed)).status).toBe(200);
      await timed.accounts.revokeKey(three.id);
      clock.advance(31_000);
      let status = 200;
      for (let i = 0; i < 100 && status !== 401; i++) {
        await Bun.sleep(20);
        status = (await lookup(three.key, timed)).status;
      }
      expect(status).toBe(401);
    } finally {
      stopTimer();
      await timed.stop();
    }
  });
});
