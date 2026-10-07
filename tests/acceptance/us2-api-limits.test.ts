import { afterAll, beforeAll, expect, test } from "bun:test";
import { bearer, issueTestKey, startTestApi, testClock, type TestApi } from "../helpers/api";
import { describeDb, withTestDb } from "../helpers/db";
import { createTestPublication, type TestPublication } from "../helpers/publication";
import { ADDR, publishRecordedSnapshot } from "../helpers/verify";

const DAY_MS = 86_400_000;
const nextMidnight = (at: Date) => Date.parse(`${at.toISOString().slice(0, 10)}T00:00:00Z`) + DAY_MS;

describeDb("US2 (spec 010): limits protect the service", () => {
  const db = withTestDb();
  // Noon UTC today: far from the day boundary unless a scenario moves the clock there.
  const clock = testClock(new Date(nextMidnight(new Date()) - DAY_MS / 2));
  let pub: TestPublication;
  let api: TestApi;

  beforeAll(async () => {
    pub = await createTestPublication();
    await publishRecordedSnapshot(pub);
    api = await startTestApi({ pub, sql: db.sql, clock: clock.now });
  });

  afterAll(async () => {
    await api?.stop();
    await pub?.stop();
  });

  const lookup = (key: string | null, target = api) =>
    target.get(`/v1/ip/${ADDR.high[4]}`, key === null ? {} : bearer(key));
  const code = async (res: Response) => ((await res.json()) as { error?: { code: string } }).error?.code ?? null;

  test("US2-1: lookups within the quota get verdicts and headers with the limit, remainder and reset", async () => {
    const { key } = await issueTestKey(api, { dailyQuota: 3, burst: 100 });
    const reset = String(nextMidnight(clock.now()) / 1000);
    for (const remaining of ["2", "1", "0"]) {
      const res = await lookup(key);
      expect(res.status).toBe(200);
      expect([res.headers.get("X-RateLimit-Limit"), res.headers.get("X-RateLimit-Remaining"), res.headers.get("X-RateLimit-Reset")])
        .toEqual(["3", remaining, reset]);
    }
  });

  test("US2-2: a lookup over the daily quota gets 429 with a retry time and no verdict", async () => {
    const { key } = await issueTestKey(api, { dailyQuota: 1, burst: 100 });
    expect((await lookup(key)).status).toBe(200);
    const res = await lookup(key);
    const body = (await res.json()) as Record<string, unknown>;
    expect(res.status).toBe(429);
    expect(body).toEqual({ error: { code: "quota_exceeded", message: expect.any(String) } });
    const retry = Number(res.headers.get("Retry-After"));
    expect(retry).toBe((nextMidnight(clock.now()) - clock.now().getTime()) / 1000);
  });

  test("US2-3: lookups faster than the burst rate get 429 for a few seconds at most", async () => {
    const { key } = await issueTestKey(api, { burst: 2 });
    const statuses: number[] = [];
    let last: Response | null = null;
    for (let i = 0; i < 3; i++) {
      last = await lookup(key);
      statuses.push(last.status);
    }
    expect(statuses).toEqual([200, 200, 429]);
    expect(await code(last!)).toBe("rate_limited");
    expect(Number(last!.headers.get("Retry-After"))).toBeLessThanOrEqual(1);
    clock.advance(1000);
    expect((await lookup(key)).status).toBe(200);
  });

  test("US2-4: no key, an unknown key or a revoked key gets 401 and no verdict", async () => {
    const missing = await lookup(null);
    expect([missing.status, await code(missing)]).toEqual([401, "key_missing"]);

    const { key, id } = await issueTestKey(api);
    await api.accounts.revokeKey(id);
    await api.reload();
    const unknown = `ftk_${"A".repeat(12)}_${"B".repeat(43)}`;
    const messages = new Set<string>();
    for (const k of [unknown, key, "ftk_bad"]) {
      const res = await lookup(k);
      const body = (await res.json()) as { error: { code: string; message: string }; risk?: unknown };
      expect({ k, status: res.status, code: body.error.code, risk: body.risk }).toEqual({ k, status: 401, code: "key_invalid", risk: undefined });
      messages.add(body.error.message);
    }
    expect(messages.size).toBe(1);
  });

  test("US2-5: the quota is full again the next UTC day, and a restart does not refill it", async () => {
    const { key } = await issueTestKey(api, { dailyQuota: 2, burst: 100 });
    expect((await lookup(key)).status).toBe(200);

    // Restart on the same database the same day: the stored count continues.
    await api.flush();
    const again = await startTestApi({ pub, sql: db.sql, clock: clock.now });
    try {
      const res = await lookup(key, again);
      expect([res.status, res.headers.get("X-RateLimit-Remaining")]).toEqual([200, "0"]);
      expect((await lookup(key, again)).status).toBe(429);

      clock.set(new Date(nextMidnight(clock.now()) + 1000));
      const next = await lookup(key, again);
      expect([next.status, next.headers.get("X-RateLimit-Remaining")]).toEqual([200, "1"]);
    } finally {
      await again.stop();
    }
  });
});
