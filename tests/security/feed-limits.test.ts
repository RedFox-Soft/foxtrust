import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activateConfig } from "../../src/db/versions";
import { getFeed } from "../../src/feeds/registry";
import type { FeedDefinition, FeedLimits } from "../../src/feeds/types";
import { runFeed, type RunOptions } from "../../src/ingest/run";
import { createIpTrust } from "../../src/lookup/lookup";
import { describeDb, resetData, withTestDb } from "../helpers/db";
import { shippedConfig } from "../helpers/seed";

const FIX = join(import.meta.dir, "..", "fixtures", "feeds");
const WIKI = join(import.meta.dir, "..", "..", "docs", "wiki", "entities");
const BOMB = join(FIX, "_security", "gzip-bomb.gz");
const FEODO = join(FIX, "feodo-tracker", "ipblocklist.json");
const SSH = join(FIX, "blocklist-de", "ssh.txt");
const LOGIN = join(FIX, "blocklist-de", "bruteforcelogin.txt");

const withLimits = (id: string, limits: Partial<FeedLimits>): FeedDefinition => {
  const def = getFeed(id)!;
  return { ...def, limits: { ...def.limits, ...limits } };
};

describeDb("SEC: feed input limits (research R14)", () => {
  const db = withTestDb();
  let tmp: string;
  let server: ReturnType<typeof Bun.serve>;
  let bomb: Uint8Array;

  beforeAll(async () => {
    tmp = await mkdtemp(join(tmpdir(), "foxtrust-sec-"));
    bomb = new Uint8Array(await Bun.file(BOMB).arrayBuffer());
    const chunk = new TextEncoder().encode("9.9.9.9\n".repeat(8192));
    server = Bun.serve({
      port: 0,
      fetch(req) {
        const path = new URL(req.url).pathname;
        if (path === "/bomb") return new Response(bomb);
        if (path === "/endless") {
          return new Response(new ReadableStream({ pull: (c) => c.enqueue(chunk) }));
        }
        if (path === "/redirect") return new Response(null, { status: 302, headers: { Location: "http://example.com/feed" } });
        return new Response("not found", { status: 404 });
      },
    });
  });
  afterAll(async () => {
    await server.stop(true);
    await rm(tmp, { recursive: true, force: true });
  });
  beforeEach(async () => {
    await resetData(db.sql);
    await activateConfig(db.sql, await shippedConfig());
  });

  const run = (feed: string, opts: Partial<RunOptions>) =>
    runFeed(db.sql, feed, { wikiRoot: WIKI, artifactRoot: join(tmp, "artifacts"), ...opts });
  const url = (path: string) => `http://127.0.0.1:${server.port}${path}`;
  const snapshot = async () =>
    (await db.sql`
      SELECT (SELECT count(*)::int FROM behavior_sighting) AS sightings,
             (SELECT count(*)::int FROM behavior_daily) AS daily,
             (SELECT count(*)::int FROM category_interval) AS categories`)[0];
  const expectRejected = async (feed: string, report: Awaited<ReturnType<typeof run>>, code: string, before: unknown) => {
    expect(report.status).toBe("failed");
    expect(report.error).toStartWith(code);
    expect(await snapshot()).toEqual(before);
    const [row] = await db.sql`SELECT stale FROM feed WHERE id = ${feed}`;
    expect(row.stale).toBe(true);
  };

  test("SEC: gzip bomb is rejected at the decompressed limit", async () => {
    await run("feodo-tracker", { fromFiles: [FEODO] });
    const before = await snapshot();
    const definition = withLimits("feodo-tracker", { maxDecompressedBytes: 20 * 1024 * 1024 });

    Bun.gc(true);
    const rss = process.memoryUsage().rss;
    const local = await run("feodo-tracker", { fromFiles: [BOMB], definition });
    const remote = await run("feodo-tracker", {
      definition, urls: { "ipblocklist.json": url("/bomb") }, allowLoopbackHttp: true,
    });
    Bun.gc(true);
    // The bomb expands to 1.1 GB; streaming stops at the limit, so memory stays small.
    expect(process.memoryUsage().rss - rss).toBeLessThan(200 * 1024 * 1024);

    await expectRejected("feodo-tracker", local, "size_limit", before);
    await expectRejected("feodo-tracker", remote, "size_limit", before);
  });

  test("SEC: oversized response is aborted", async () => {
    await run("feodo-tracker", { fromFiles: [FEODO] });
    const before = await snapshot();
    const report = await run("feodo-tracker", {
      definition: withLimits("feodo-tracker", { maxCompressedBytes: 5 * 1024 * 1024 }),
      urls: { "ipblocklist.json": url("/endless") },
      allowLoopbackHttp: true,
    });
    await expectRejected("feodo-tracker", report, "size_limit", before);
  });

  test("SEC: redirect to http is refused", async () => {
    await run("feodo-tracker", { fromFiles: [FEODO] });
    const before = await snapshot();
    const report = await run("feodo-tracker", {
      urls: { "ipblocklist.json": url("/redirect") },
      allowLoopbackHttp: true,
    });
    await expectRejected("feodo-tracker", report, "insecure_redirect", before);
  });

  test("SEC: too many entries", async () => {
    await run("feodo-tracker", { fromFiles: [FEODO] });
    const before = await snapshot();
    const report = await run("blocklist-de", {
      fromFiles: [SSH, LOGIN],
      definition: withLimits("blocklist-de", { maxEntries: 100 }),
    });
    await expectRejected("blocklist-de", report, "too_many_entries", before);
  });

  test("SEC: malformed CIDR text cannot reach SQL", async () => {
    const hostile = join(tmp, "hostile", "ssh.txt");
    await Bun.write(
      hostile,
      ["1.2.3.0/24'); DROP TABLE feed;--", "1.2.3.4; DELETE FROM feed_run", "' OR 1=1 --", "5.6.7.8"].join("\n"),
    );
    const report = await run("blocklist-de", { fromFiles: [hostile, LOGIN] });
    expect(report.status).toBe("applied");
    expect(report.invalidLines).toBe(3);

    const [tables] = await db.sql`
      SELECT (SELECT count(*)::int FROM feed) AS feeds, (SELECT count(*)::int FROM feed_run) AS runs`;
    expect(tables.feeds).toBeGreaterThan(0);
    expect(tables.runs).toBeGreaterThan(0);
    const client = createIpTrust({ databaseUrl: db.url });
    try {
      const result = await client.lookup("5.6.7.8");
      expect(result.ok && result.verdict.reasons.map((r) => r.code)).toEqual(["ssh_bruteforce"]);
    } finally {
      await client.close();
    }
  });
});
