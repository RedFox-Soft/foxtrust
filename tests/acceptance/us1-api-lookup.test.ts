import { afterAll, beforeAll, expect, test } from "bun:test";
import Ajv2020 from "ajv/dist/2020";
import schema from "../../schemas/api-ip-v1.schema.json";
import { bearer, issueTestKey, startTestApi, testClock, type TestApi } from "../helpers/api";
import { describeDb, withTestDb } from "../helpers/db";
import { createTestPublication, type TestPublication } from "../helpers/publication";
import { ADDR, publishRecordedSnapshot } from "../helpers/verify";

const validate = new Ajv2020({ validateFormats: false }).compile(schema);

describeDb("US1 (spec 010): a developer looks up an address with a free key", () => {
  const db = withTestDb();
  let pub: TestPublication;
  let api: TestApi;
  let key: string;

  beforeAll(async () => {
    pub = await createTestPublication();
    await publishRecordedSnapshot(pub);
    api = await startTestApi({ pub, sql: db.sql });
    ({ key } = await issueTestKey(api, { burst: 1000 }));
  });

  afterAll(async () => {
    await api?.stop();
    await pub?.stop();
  });

  const lookup = async (ip: string) => {
    const res = await api.get(`/v1/ip/${ip}`, bearer(key));
    return { res, body: (await res.json()) as Record<string, unknown> };
  };

  test("US1-1: a listed address gets its customer verdict, the data version and the dispute link", async () => {
    const { res, body } = await lookup(ADDR.high[4]);
    expect(res.status).toBe(200);
    expect(validate(body)).toBe(true);
    expect(body).toMatchObject({
      ip: ADDR.high[4], risk: 82, level: "high", categories: ["hosting"],
      data: { version: "f20261001", delta: null, stale: false }, disputeUrl: "https://foxtrust.example/dispute",
    });
    const reasons = body.reasons as { code: string; lastSeen: string; contribution: number }[];
    expect(reasons.map((r) => [r.code, r.contribution])).toEqual([["hosting", 41], ["botnet_c2", 41]]);
    for (const r of reasons) expect(Date.parse(r.lastSeen)).toBeGreaterThan(Date.now() - 2 * 3_600_000);
  });

  test("US1-2: IPv6 and IPv4-mapped IPv6 get the verdict of their address", async () => {
    const v6 = await lookup(ADDR.tor[6]);
    expect(v6.res.status).toBe(200);
    expect(v6.body).toMatchObject({ ip: ADDR.tor[6], risk: 34.3, level: "medium", categories: ["tor"] });
    const mapped = await lookup(`::ffff:${ADDR.tor[4]}`);
    const plain = await lookup(ADDR.tor[4]);
    expect(mapped.body).toEqual(plain.body);
    expect(mapped.body.ip).toBe(ADDR.tor[4]);
  });

  test("US1-3: an address in no listed range gets a verdict with risk 0, not an error", async () => {
    for (const ip of [ADDR.unlisted[4], ADDR.unlisted[6]]) {
      const { res, body } = await lookup(ip);
      expect({ ip, status: res.status }).toEqual({ ip, status: 200 });
      expect(body).toMatchObject({ ip, risk: 0, level: "low", categories: [], reasons: [], network: { asn: null, org: null, country: null } });
    }
  });

  test("US1-4: something that is not an address gets 400 and does not count against the quota", async () => {
    const before = Number((await api.get(`/v1/ip/${ADDR.low[4]}`, bearer(key))).headers.get("X-RateLimit-Remaining"));
    for (const path of ["not-an-ip", "1.2.3.0%2F24", "01.2.3.4", "fe80::1%25eth0"]) {
      const { res, body } = await lookup(path);
      expect({ path, status: res.status, code: (body.error as { code: string }).code }).toEqual({ path, status: 400, code: "invalid_ip" });
      expect(Number(res.headers.get("X-RateLimit-Remaining"))).toBe(before);
    }
  });

  test("US1-5: before the first snapshot lookups get 503 without using the quota; old data is marked stale", async () => {
    const empty = await startTestApi({ pub: null, sql: db.sql });
    try {
      const { key: other } = await issueTestKey(empty);
      for (const _ of [1, 2]) {
        const res = await empty.get(`/v1/ip/${ADDR.high[4]}`, bearer(other));
        expect(res.status).toBe(503);
        expect(((await res.json()) as { error: { code: string } }).error.code).toBe("no_data");
        expect(res.headers.get("Retry-After")).not.toBeNull();
        expect(res.headers.get("X-RateLimit-Remaining")).toBe("1000");
      }
    } finally {
      await empty.stop();
    }

    const clock = testClock();
    const late = await startTestApi({ pub, sql: db.sql, clock: clock.now });
    try {
      const { key: other } = await issueTestKey(late);
      clock.advance(27 * 3_600_000);
      const res = await late.get(`/v1/ip/${ADDR.high[4]}`, bearer(other));
      expect(res.status).toBe(200);
      expect(((await res.json()) as { data: { stale: boolean } }).data.stale).toBe(true);
    } finally {
      await late.stop();
    }
  });
});
