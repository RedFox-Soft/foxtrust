import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAlertTick } from "../../src/alerts/reconcile";
import { readAlertSettings } from "../../src/alerts/settings";
import { activateConfig } from "../../src/db/versions";
import { runFeed } from "../../src/ingest/run";
import { runJob, startScheduler } from "../../src/ingest/schedule";
import { describeDb, resetData, withTestDb } from "../helpers/db";
import { startFakeTelegram, settingsFor, type FakeMode, type FakeTelegram } from "../helpers/fake-telegram";
import { fixturePath } from "../helpers/fixture-data";
import { shippedConfig } from "../helpers/seed";

const HOUR = 3_600_000;
const TIMEOUT_MS = 500;

describeDb("US4 (spec 004): alerts stay quiet and never get in the way", () => {
  const db = withTestDb();
  let fake: FakeTelegram;
  let tmp: string;
  const logs: string[] = [];
  const deps = () => ({ sql: db.sql, log: (l: string) => logs.push(l), record: true });
  const fail = (name: string) => runJob(name, name, () => Promise.reject(new Error(`${name} broke`)), deps());
  const succeed = (name: string) => runJob(name, name, () => Promise.resolve(), deps());
  const newTick = (now?: () => Date) =>
    createAlertTick({
      sql: db.sql, settings: settingsFor(fake), startedAt: new Date(), log: (l) => logs.push(l), derivers: [],
      timeoutMs: TIMEOUT_MS, ...(now ? { now } : {}),
    });
  const problemRows = async () => Number((await db.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM alert_problem`)[0]!.n);

  beforeAll(async () => {
    fake = startFakeTelegram();
    tmp = await mkdtemp(join(tmpdir(), "foxtrust-004-us4-"));
  });
  afterAll(async () => {
    await fake.stop();
    await rm(tmp, { recursive: true, force: true });
  });
  beforeEach(async () => {
    await resetData(db.sql);
    await activateConfig(db.sql, await shippedConfig());
    await fake.reset();
    logs.length = 0;
  });

  test("US4-1: an open problem gets exactly one reminder 24 hours after its last message, none before", async () => {
    await fail("retention");
    const t0 = Date.now();
    let now = new Date(t0);
    const tick = newTick(() => now);
    await tick();
    now = new Date(t0 + 23 * HOUR);
    await tick();
    expect(fake.accepted()).toHaveLength(1);

    now = new Date(t0 + 24 * HOUR + 60_000);
    await tick();
    now = new Date(t0 + 25 * HOUR);
    await tick();
    const texts = fake.accepted();
    expect(texts).toHaveLength(2);
    expect(texts[1]).toContain("⏰ Still open after 1 d:");
    expect(texts[1]).toContain("Job retention failed: retention broke");
  });

  test("US4-2: an unreachable, failing or silent endpoint never holds up jobs; pending changes arrive later, in order", async () => {
    const tick = newTick();
    const modes: FakeMode[] = ["http500", "hang", "closed"];
    for (const mode of modes) {
      await fake.setMode(mode);
      let feedStatus = "";
      await runJob("ingest:tor-exit", "tor-exit", async () => {
        feedStatus = (await runFeed(db.sql, "tor-exit", { fromFiles: [fixturePath("tor-exit", "exit-list.txt")], artifactRoot: join(tmp, "a") })).status;
      }, deps());
      expect(["applied", "unchanged"]).toContain(feedStatus);
      const started = performance.now();
      await tick();
      expect(performance.now() - started).toBeLessThan(TIMEOUT_MS + 1_500);
    }
    // Opened and resolved while undeliverable, then a problem that stays open.
    await fail("snapshot-retention");
    await Bun.sleep(10);
    await fail("snapshot-full");
    await Bun.sleep(10);
    await succeed("snapshot-retention");
    await tick();
    expect(fake.accepted()).toHaveLength(0);
    expect(logs.some((l) => l.startsWith("alerts: delivery failed"))).toBe(true);

    await fake.setMode("accept");
    await tick();
    const texts = fake.accepted();
    expect(texts).toHaveLength(1);
    const opened = texts[0]!.indexOf("⚠️ Job snapshot-full failed: snapshot-full broke");
    const unseen = texts[0]!.indexOf("☑️ Job snapshot-retention failed: snapshot-retention broke — resolved after");
    expect(opened).toBeGreaterThan(0);
    expect(unseen).toBeGreaterThan(opened);
    await tick();
    expect(fake.accepted()).toHaveLength(1);
  });

  test("US4-3: without a bot token or chat id the scheduler logs that alerts are disabled and records nothing", async () => {
    const settings = await readAlertSettings({});
    expect(settings).toEqual({ enabled: false, reason: "FOXTRUST_TELEGRAM_BOT_TOKEN and FOXTRUST_TELEGRAM_CHAT_ID are not set", invalid: false });
    const lines: string[] = [];
    const stop = startScheduler(db.sql, [], (l) => lines.push(l), { alerts: settings });
    stop();
    expect(lines.filter((l) => l.startsWith("alerts:"))).toEqual([
      "alerts: disabled (FOXTRUST_TELEGRAM_BOT_TOKEN and FOXTRUST_TELEGRAM_CHAT_ID are not set)",
    ]);
    await runJob("retention", "retention", () => Promise.reject(new Error("boom")), { sql: db.sql, log: () => {}, record: false });
    expect(await problemRows()).toBe(0);
    expect(fake.requests).toHaveLength(0);
  });

  test("US4-4: after a restart open problems are not reported again, and one resolved meanwhile gets its recovery", async () => {
    await fail("retention");
    await fail("snapshot-delta");
    await newTick()();
    expect(fake.accepted()).toHaveLength(1);
    await succeed("snapshot-delta"); // resolved while the scheduler is down

    await newTick()(); // a new process: fresh in-memory state, same database
    const texts = fake.accepted();
    expect(texts).toHaveLength(2);
    expect(texts[1]).toContain("✅ Resolved after");
    expect(texts[1]).toContain("job snapshot-delta completed");
    expect(texts[1]).not.toContain("⚠️");
  });
});
