import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requestRelease, runOperatorRequests } from "../../src/admin/requests";
import { FEEDS } from "../../src/feeds/registry";
import { runFeed } from "../../src/ingest/run";
import { signIn, startTestAdmin, type Browser, type TestAdmin } from "../helpers/admin";
import { describeDb, withTestDb } from "../helpers/db";
import { fixturePath, loadFixtureFeeds } from "../helpers/fixture-data";
import { startFakeOidc, type FakeOidc } from "../helpers/oidc";

const TOR_FULL = fixturePath("tor-exit", "exit-list.txt");

describeDb("US3 (spec 011): the operator sees the health of the pipeline", () => {
  const db = withTestDb();
  let tmp: string;
  let oidc: FakeOidc;
  let admin: TestAdmin;
  let op: Browser;
  let heldRun: number;

  beforeAll(async () => {
    tmp = await mkdtemp(join(tmpdir(), "foxtrust-011-us3-"));
    await loadFixtureFeeds(db.sql, ["tor-exit", "x4bnet-datacenter"]);
    // Three exit relays out of the full list: the shrink guard holds the run (as spec 004 US1-1).
    const lines = (await Bun.file(TOR_FULL).text()).split("\n");
    const cut = lines.findIndex((l, i) => l.startsWith("ExitAddress") && lines.slice(0, i + 1).filter((x) => x.startsWith("ExitAddress")).length === 3);
    const torSmall = join(tmp, "exit-list.txt");
    await Bun.write(torSmall, `${lines.slice(0, cut + 1).join("\n")}\n`);
    const held = await runFeed(db.sql, "tor-exit", { fromFiles: [torSmall], artifactRoot: join(tmp, "artifacts") });
    if (held.status !== "held") throw new Error(`expected a held run, got ${held.status}`);
    heldRun = held.runId!;

    await db.sql`UPDATE feed SET stale = true WHERE id = 'x4bnet-datacenter'`;
    const now = new Date();
    await db.sql`
      INSERT INTO alert_problem (key, kind, subject, state, opened_at, changed_at, details)
      VALUES ('feed:x4bnet-datacenter', 'feed', 'x4bnet-datacenter', 'open', ${now}, ${now}, ${JSON.stringify({ stale: true })}::jsonb)`;
    const [dv] = (await db.sql`SELECT max(id) AS id FROM data_version`) as { id: number }[];
    await db.sql`
      INSERT INTO snapshot_release (version, kind, data_version_id, algorithm_version, config_sha256, built_at, status)
      VALUES ('f20261007', 'full', ${dv!.id}, 'noisy-or/1', 'test', ${now}, 'held')`;
    await requestRelease(db.sql, { version: "f20261007", note: "Expected change in the Tor list, verified.", who: { subject: "operator-1", name: "Test Operator" } });

    oidc = await startFakeOidc();
    admin = await startTestAdmin({ sql: db.sql, oidc });
    op = (await signIn(admin, oidc)).browser;
  }, 120_000);

  afterAll(async () => {
    await admin?.stop();
    await oidc?.stop();
    if (tmp) await rm(tmp, { recursive: true, force: true });
  });

  test("US3-1: the overview lists open alerts, held runs, stale feeds, held releases and pending requests", async () => {
    const html = await (await op.get("/")).text();
    const section = (title: string) => html.split(`<h2>${title}</h2>`)[1]!.split("<h2>")[0]!;
    expect(section("Open alerts")).toContain("feed:x4bnet-datacenter");
    expect(section("Held feed runs")).toContain(`/feeds/runs/${heldRun}/confirm`);
    expect(section("Held feed runs")).toContain("tor-exit");
    expect(section("Stale feeds")).toContain("x4bnet-datacenter");
    expect(section("Held releases")).toContain("f20261007");
    expect(section("Pending requests")).toMatch(/release<\/td><td>f20261007<\/td><td>\d+ min \(by Test Operator\)/);
  });

  test("US3-2: the feed list shows each feed's last run, staleness and whether the active config enables it", async () => {
    const html = await (await op.get("/feeds")).text();
    const rowOf = (feed: string) => html.split("<tr>").find((r) => r.startsWith(`<td>${feed}</td>`)) ?? "";
    for (const def of FEEDS) expect({ feed: def.id, listed: rowOf(def.id) !== "" }).toEqual({ feed: def.id, listed: true });
    const tor = rowOf("tor-exit");
    expect(tor).toContain("status-held");
    expect(tor).toMatch(/<td>3<\/td><td>\d+<\/td>/);
    expect(rowOf("x4bnet-datacenter")).toContain(">stale<");
    expect(rowOf("tor-exit")).toContain("<td>yes</td>");
    // A feed the fixture config does not score (spec 005's cloud feed) shows "no".
    expect(rowOf("ipverse-cloud")).toContain("<td>no</td>");
  });

  test("US3-3: a held run is confirmed after a confirmation page; the scheduler applies it", async () => {
    const confirm = await (await op.get(`/feeds/runs/${heldRun}/confirm`)).text();
    expect(confirm).toContain(`action="/feeds/runs/${heldRun}/confirm"`);
    expect(confirm).toContain("3 entries");
    expect((await op.post(`/feeds/runs/${heldRun}/confirm`, { note: "Tor list really shrank" })).status).toBe(303);
    const [request] = (await db.sql`SELECT kind, target, state FROM operator_request WHERE kind = 'confirm_run'`) as Record<string, string>[];
    expect(request).toEqual({ kind: "confirm_run", target: String(heldRun), state: "requested" });
    expect(((await db.sql`SELECT count(*)::int AS n FROM admin_audit WHERE action = 'run.confirm.request'`) as { n: number }[])[0]!.n).toBe(1);

    const done = await runOperatorRequests({ sql: db.sql, release: null });
    expect(done.map((r) => [r.kind, r.state])).toEqual([["confirm_run", "done"]]);
    const [run] = (await db.sql`SELECT status FROM feed_run WHERE id = ${heldRun}`) as { status: string }[];
    expect(run!.status).toBe("applied");
    // Without the signing key, the release request waits for the scheduler that has it.
    expect(((await db.sql`SELECT state FROM operator_request WHERE kind = 'release'`) as { state: string }[])[0]!.state).toBe("requested");
  });
});
