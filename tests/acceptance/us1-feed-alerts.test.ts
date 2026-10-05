import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { feedDeriver } from "../../src/alerts/derive";
import { createAlertTick } from "../../src/alerts/reconcile";
import { activateConfig } from "../../src/db/versions";
import { getFeed } from "../../src/feeds/registry";
import type { FeedDefinition } from "../../src/feeds/types";
import { confirmHeldRun, runFeed, type RunOptions } from "../../src/ingest/run";
import { describeDb, resetData, withTestDb } from "../helpers/db";
import { startFakeTelegram, settingsFor, type FakeTelegram } from "../helpers/fake-telegram";
import { fixturePath } from "../helpers/fixture-data";
import { shippedConfig } from "../helpers/seed";

const HOUR = 3_600_000;
const TOR_FULL = fixturePath("tor-exit", "exit-list.txt");

describeDb("US1 (spec 004): feed problems reach the operator", () => {
  const db = withTestDb();
  let fake: FakeTelegram;
  let broken: ReturnType<typeof Bun.serve>;
  let tmp: string;
  let torSmall: string;
  let emptyWiki: string;
  const tor = getFeed("tor-exit")!;
  const x4b = getFeed("x4bnet-datacenter")!;

  const ingest = (feed: string, opts: RunOptions) => runFeed(db.sql, feed, { artifactRoot: join(tmp, "artifacts"), ...opts });
  const failTor = () =>
    ingest("tor-exit", { urls: { "exit-list.txt": `${broken.url.href}exit-list.txt` }, allowLoopbackHttp: true });
  const tickAt = (now: Date, feeds: FeedDefinition[], startedAt = now) =>
    createAlertTick({
      sql: db.sql, settings: settingsFor(fake), startedAt, log: () => {}, derivers: [feedDeriver(feeds)],
      now: () => now, timeoutMs: 2_000,
    })();

  beforeAll(async () => {
    fake = startFakeTelegram();
    broken = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("unavailable", { status: 503 }) });
    tmp = await mkdtemp(join(tmpdir(), "foxtrust-004-us1-"));
    emptyWiki = join(tmp, "empty-wiki");
    await mkdir(emptyWiki, { recursive: true });
    // Three exit relays out of the full list: under half the previous entries, so the shrink guard holds it.
    const lines = (await Bun.file(TOR_FULL).text()).split("\n");
    const cut = lines.findIndex((l, i) => l.startsWith("ExitAddress") && lines.slice(0, i + 1).filter((x) => x.startsWith("ExitAddress")).length === 3);
    torSmall = join(tmp, "exit-list.txt");
    await Bun.write(torSmall, `${lines.slice(0, cut + 1).join("\n")}\n`);
  });
  afterAll(async () => {
    await fake.stop();
    await broken.stop(true);
    await rm(tmp, { recursive: true, force: true });
  });
  beforeEach(async () => {
    await resetData(db.sql);
    await activateConfig(db.sql, await shippedConfig());
    await fake.reset();
  });

  test("US1-1: a held feed run produces one message with the run, the counts and the confirm command", async () => {
    expect((await ingest("tor-exit", { fromFiles: [TOR_FULL] })).status).toBe("applied");
    const held = await ingest("tor-exit", { fromFiles: [torSmall] });
    expect(held.status).toBe("held");

    await tickAt(new Date(), [tor]);
    const texts = fake.accepted();
    expect(texts).toHaveLength(1);
    expect(texts[0]!.split("\n")[0]).toBe("FoxTrust: 1 needs attention");
    expect(texts[0]).toContain(`Feed tor-exit: run ${held.runId} held, ${held.entryCount} entries vs ${held.previousEntryCount} before.`);
    expect(texts[0]).toContain(`→ foxtrust feeds confirm ${held.runId}`);
    expect(fake.requests[0]!.body.chat_id).toBe("-1001234567890");
  });

  test("US1-2: a feed without a successful run for over twice its interval produces one message with last success and last error", async () => {
    expect((await ingest("tor-exit", { fromFiles: [TOR_FULL] })).status).toBe("applied");
    expect((await failTor()).status).toBe("failed");
    // Never succeeded: its licence page is missing.
    const missing = await ingest("x4bnet-datacenter", {
      fromFiles: [fixturePath("x4bnet-datacenter", "ipv4.txt"), fixturePath("x4bnet-datacenter", "ipv6.txt")], wikiRoot: emptyWiki,
    });
    expect(missing.status).toBe("licence_missing");

    const now = new Date(Date.now() + 3 * HOUR); // tor-exit runs hourly: stale after 2 h
    await tickAt(now, [tor, x4b], new Date(now.getTime() - 72 * HOUR)); // x4bnet runs daily: stale after 48 h
    const texts = fake.accepted();
    expect(texts).toHaveLength(1);
    expect(texts[0]!.split("\n")[0]).toBe("FoxTrust: 2 need attention");
    expect(texts[0]).toMatch(/Feed tor-exit: no successful run since \d{4}-\d\d-\d\d \d\d:\d\d UTC \(expected every hour\)\./);
    expect(texts[0]).toContain("Last error: http_error: HTTP 503");
    expect(texts[0]).toContain("Feed x4bnet-datacenter: no successful run since never (expected every day).");
    expect(texts[0]).toContain("Last error: no licence page x4bnet-datacenter.md");
  });

  test("US1-3: when the held run is confirmed, one recovery message follows with the duration", async () => {
    await ingest("tor-exit", { fromFiles: [TOR_FULL] });
    const held = await ingest("tor-exit", { fromFiles: [torSmall] });
    const t0 = new Date();
    await tickAt(t0, [tor]);
    await confirmHeldRun(db.sql, held.runId!);

    await tickAt(new Date(t0.getTime() + 90 * 60_000), [tor], t0);
    const texts = fake.accepted();
    expect(texts).toHaveLength(2);
    expect(texts[1]!.split("\n")[0]).toBe("FoxTrust: all clear, 1 resolved");
    expect(texts[1]).toMatch(/✅ Resolved after \d+ (min|h)[^:]*: feed tor-exit updates again/);
  });

  test("US1-4: further failures of an open feed problem send nothing before its reminder is due", async () => {
    await ingest("tor-exit", { fromFiles: [TOR_FULL] });
    await failTor();
    const now = Date.now() + 3 * HOUR;
    await tickAt(new Date(now), [tor], new Date(now - 72 * HOUR));
    for (const later of [1, 5, 20]) {
      await failTor();
      await tickAt(new Date(now + later * HOUR), [tor], new Date(now - 72 * HOUR));
    }
    expect(fake.accepted()).toHaveLength(1);
  });
});
