import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { createAlertTick } from "../../src/alerts/reconcile";
import { createRedactor } from "../../src/alerts/redact";
import { sendTelegram } from "../../src/alerts/telegram";
import { runJob } from "../../src/ingest/schedule";
import { describeDb, resetData, withTestDb } from "../helpers/db";
import { startFakeTelegram, settingsFor, TEST_TOKEN, type FakeTelegram } from "../helpers/fake-telegram";

describeDb("SEC (spec 004): the Telegram bot token is a secret", () => {
  const db = withTestDb();
  let fake: FakeTelegram;
  const forms = [TEST_TOKEN, encodeURIComponent(TEST_TOKEN)];
  const leaks = (text: string) => forms.some((f) => text.includes(f));

  beforeAll(() => {
    fake = startFakeTelegram();
  });
  afterAll(async () => {
    await fake.stop();
  });
  beforeEach(async () => {
    await resetData(db.sql);
    await fake.reset();
  });

  test("SEC: the bot token never leaks into logs, errors, CLI output or the database", async () => {
    const logs: string[] = [];
    const settings = settingsFor(fake);

    // A job error that carries the Telegram request URL, as a fetch error can.
    await runJob(
      "snapshot-delta", "snapshot delta",
      () => Promise.reject(new Error(`request to ${settings.apiUrl}/bot${TEST_TOKEN}/sendMessage failed (${encodeURIComponent(TEST_TOKEN)})`)),
      { sql: db.sql, log: (l) => logs.push(l), record: true, redact: createRedactor(TEST_TOKEN) },
    );

    const tick = createAlertTick({ sql: db.sql, settings, startedAt: new Date(), log: (l) => logs.push(l), derivers: [], timeoutMs: 500 });
    const reasons: string[] = [];
    for (const mode of ["closed", "unauthorized", "http500", "hang"] as const) {
      await fake.setMode(mode);
      await tick();
      const result = await sendTelegram(settings, "probe", { timeoutMs: 500 });
      if (!result.ok) reasons.push(result.reason);
    }
    await fake.setMode("accept");
    await tick();

    const cli: string[] = [];
    for (const mode of ["unauthorized", "closed"] as const) {
      await fake.setMode(mode);
      const proc = Bun.spawn(["bun", "run", "src/cli/main.ts", "alerts", "test"], {
        env: { ...Bun.env, FOXTRUST_TELEGRAM_BOT_TOKEN: TEST_TOKEN, FOXTRUST_TELEGRAM_CHAT_ID: "-1001234567890", FOXTRUST_TELEGRAM_API_URL: fake.url },
        stdout: "pipe", stderr: "pipe",
      });
      expect(await proc.exited).toBe(1);
      cli.push(await new Response(proc.stdout).text(), await new Response(proc.stderr).text());
    }
    const rows = await db.sql<{ row: string }[]>`SELECT row_to_json(p)::text AS row FROM alert_problem p`;

    expect(rows.length).toBeGreaterThan(0);
    expect(logs.length).toBeGreaterThan(0);
    expect(reasons.length).toBe(4);
    expect(fake.accepted().join("\n")).toContain("<redacted>");
    for (const text of [...logs, ...reasons, ...cli, ...rows.map((r) => r.row), ...fake.accepted()]) {
      expect({ text, leaks: leaks(text) }).toEqual({ text, leaks: false });
    }
  }, 30_000);
});
