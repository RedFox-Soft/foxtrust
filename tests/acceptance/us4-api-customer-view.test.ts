import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020";
import schema from "../../schemas/api-ip-v1.schema.json";
import { resolveVersionAt } from "../../src/db/versions";
import { FEEDS } from "../../src/feeds/registry";
import { toIpValue, type IpValue } from "../../src/ip/parse";
import { gatherSignals } from "../../src/lookup/signals";
import { buildAndRelease } from "../../src/snapshot/publish";
import { customerRecord } from "../../src/snapshot/ranges";
import { loadSigningKey } from "../../src/snapshot/sign";
import { bearer, issueTestKey, startTestApi, type TestApi } from "../helpers/api";
import { describeDb, withTestDb } from "../helpers/db";
import { fixturePath, loadFixtureDataset } from "../helpers/fixture-data";
import { createTestPublication, type TestPublication } from "../helpers/publication";
import { ADDR, publishRecordedSnapshot } from "../helpers/verify";

const validate = new Ajv2020({ validateFormats: false }).compile(schema);
const FEED_IDS = FEEDS.map((f) => f.id);
const ip = (text: string): IpValue => {
  const v = toIpValue(text);
  if ("error" in v) throw new Error(v.error);
  return v;
};
const lines = async (path: string) => (await Bun.file(path).text()).split(/\r?\n/).filter((l) => l.trim() !== "" && !l.startsWith("#"));
type Body = { risk: number; level: string; categories: string[]; reasons: { code: string; lastSeen: string; contribution: number }[] };

describeDb("US4 (spec 010): the answer never says more than the customer view", () => {
  const db = withTestDb();
  let tmp: string;
  let built: TestPublication;
  let recorded: TestPublication;
  let builtApi: TestApi;
  let api: TestApi;
  let builtKey: string;
  let key: string;
  let builtAt: Date;

  beforeAll(async () => {
    tmp = await mkdtemp(join(tmpdir(), "foxtrust-api-us4-"));
    await loadFixtureDataset(db.sql);
    built = await createTestPublication();
    builtAt = new Date();
    const result = await buildAndRelease(db.sql, "full", {
      dir: built.dir, workDir: join(tmp, "work"), key: await loadSigningKey(built.signingKeyPath),
      disputeUrl: "https://foxtrust.example/dispute", sample: 400, at: builtAt, now: builtAt,
    });
    if (result.status !== "published") throw new Error(`full release: ${result.status}`);
    builtApi = await startTestApi({ pub: built, sql: db.sql });
    ({ key: builtKey } = await issueTestKey(builtApi, { burst: 1000 }));

    recorded = await createTestPublication();
    await publishRecordedSnapshot(recorded);
    api = await startTestApi({ pub: recorded, sql: db.sql });
    ({ key } = await issueTestKey(api, { burst: 1000 }));
  }, 180_000);

  afterAll(async () => {
    await builtApi?.stop();
    await api?.stop();
    await built?.stop();
    await recorded?.stop();
    if (tmp) await rm(tmp, { recursive: true, force: true });
  });

  test("US4-1: a signal of a feed that does not ship changes nothing in the answer", async () => {
    const version = (await resolveVersionAt(db.sql, builtAt))!;
    const cymru = [
      ...(await lines(fixturePath("cymru-fullbogons", "fullbogons-ipv4.txt"))).slice(0, 40),
      ...(await lines(fixturePath("cymru-fullbogons", "fullbogons-ipv6.txt"))).slice(0, 40),
    ].map((cidr) => cidr.split("/")[0]!);
    let checked = 0;
    let onlyLocal = 0;
    let mixed = 0;
    for (const address of cymru) {
      const { signals, network } = await gatherSignals(db.sql, ip(address), builtAt);
      if (!signals.some((s) => s.source === "cymru-fullbogons" && !s.shippable)) continue;
      const res = await builtApi.get(`/v1/ip/${address}`, bearer(builtKey));
      const body = (await res.json()) as Body;
      const reference = customerRecord(signals, network, version.config, builtAt) as
        | { risk: number; level: string; categories: string[]; reasons: { code: string; last_seen: number; contribution: number }[] }
        | null;
      if (reference === null) {
        onlyLocal++;
        expect({ address, risk: body.risk, reasons: body.reasons, categories: body.categories }).toEqual({ address, risk: 0, reasons: [], categories: [] });
      } else {
        if (signals.some((s) => s.shippable)) mixed++;
        expect({ address, risk: body.risk, level: body.level, categories: body.categories }).toEqual({
          address, risk: reference.risk, level: reference.level, categories: reference.categories,
        });
        expect(body.reasons.map((r) => [r.code, Date.parse(r.lastSeen) / 1000, r.contribution]))
          .toEqual(reference.reasons.map((r) => [r.code, r.last_seen, r.contribution]));
      }
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
    // Both cases occur in the fixtures: Cymru alone, and Cymru beside the shipped IANA bogon.
    expect({ onlyLocal: onlyLocal > 0, mixed: mixed > 0 }).toEqual({ onlyLocal: true, mixed: true });
  });

  test("US4-2: no answer, header or error names a feed or shows a reason prefix", async () => {
    const targets = [...Object.values(ADDR).flatMap((a) => [a[4], a[6]]), "not-an-ip"];
    for (const target of targets) {
      const res = await api.get(`/v1/ip/${target}`, bearer(key));
      const text = await res.text();
      const headers = JSON.stringify([...res.headers.entries()]);
      expect(validate(JSON.parse(text))).toBe(true);
      for (const id of FEED_IDS) expect({ target, id, leaked: text.includes(id) || headers.includes(id) }).toEqual({ target, id, leaked: false });
      expect(text).not.toMatch(/"(source|prefix)"/);
    }
  });

  test("US4-3: usage and logs hold key id, time, outcome and counts, never an address or the secret", async () => {
    const addresses = Object.values(ADDR).flatMap((a) => [a[4], a[6]]);
    for (const address of addresses) expect((await api.get(`/v1/ip/${address}`, bearer(key))).status).toBe(200);
    await api.flush();
    const summary = api.summarize();
    expect(summary).toMatch(/^api: last minute answered=\d+ invalid=\d+ limited=\d+ unauthorized=\d+ unavailable=\d+ refused=\d+ keys=\d+$/);

    const columns = (await db.sql`
      SELECT column_name FROM information_schema.columns WHERE table_name = 'api_usage_daily' ORDER BY ordinal_position`) as { column_name: string }[];
    expect(columns.map((c) => c.column_name)).toEqual(["key_id", "day", "answered", "invalid", "limited"]);
    const rows = JSON.stringify(await db.sql`SELECT * FROM api_usage_daily`);
    const secret = key.split("_").at(-1)!;
    for (const text of [rows, ...api.logs]) {
      for (const address of addresses) expect({ address, leaked: text.includes(address) }).toEqual({ address, leaked: false });
      expect(text.includes(secret)).toBe(false);
    }
  });
});
