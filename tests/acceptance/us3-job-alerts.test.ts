import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { createAlertTick } from "../../src/alerts/reconcile";
import { runJob } from "../../src/ingest/schedule";
import { describeDb, resetData, withTestDb } from "../helpers/db";
import { startFakeTelegram, settingsFor, type FakeTelegram } from "../helpers/fake-telegram";

describeDb("US3 (spec 004): scheduler job errors reach the operator", () => {
  const db = withTestDb();
  let fake: FakeTelegram;
  const logs: string[] = [];
  const deps = () => ({ sql: db.sql, log: (l: string) => logs.push(l), record: true });
  const tick = () =>
    createAlertTick({ sql: db.sql, settings: settingsFor(fake), startedAt: new Date(), log: () => {}, derivers: [], timeoutMs: 2_000 })();

  beforeAll(() => {
    fake = startFakeTelegram();
  });
  afterAll(async () => {
    await fake.stop();
  });
  beforeEach(async () => {
    await resetData(db.sql);
    await fake.reset();
    logs.length = 0;
  });

  test("US3-1: a scheduled job that throws produces one message naming the job and the error", async () => {
    await runJob("retention", "retention", () => Promise.reject(new Error("connection refused by the database")), deps());
    expect(logs.some((l) => l.endsWith("retention: error connection refused by the database"))).toBe(true);

    await tick();
    const texts = fake.accepted();
    expect(texts).toHaveLength(1);
    expect(texts[0]).toContain("⚠️ Job retention failed: connection refused by the database");
  });

  test("US3-2: the same job completing on a later run produces one recovery message", async () => {
    await runJob("snapshot-delta", "snapshot delta", () => Promise.reject(new Error("disk full")), deps());
    await tick();
    await runJob("snapshot-delta", "snapshot delta", () => Promise.resolve(), deps());

    await tick();
    const texts = fake.accepted();
    expect(texts).toHaveLength(2);
    expect(texts[1]).toMatch(/✅ Resolved after \d+ min: job snapshot-delta completed/);
  });
});
