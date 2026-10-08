import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runOperatorRequests } from "../../src/admin/requests";
import { buildAndRelease, publishStaged, type ReleaseOptions } from "../../src/snapshot/publish";
import { loadSigningKey } from "../../src/snapshot/sign";
import { category, knownGoodFile } from "../helpers/accuracy";
import { signIn, startTestAdmin, type Browser, type TestAdmin } from "../helpers/admin";
import { describeDb, withTestDb } from "../helpers/db";
import { loadFixtureFeeds } from "../helpers/fixture-data";
import { startFakeOidc, type FakeOidc } from "../helpers/oidc";
import { createTestPublication, type TestPublication } from "../helpers/publication";
import { seedRows } from "../helpers/seed";

const DAY = 86_400_000;

describeDb("US2 (spec 011): the operator releases a held snapshot", () => {
  const db = withTestDb();
  let tmp: string;
  let pub: TestPublication;
  let opts: ReleaseOptions;
  let oidc: FakeOidc;
  let admin: TestAdmin;
  let op: Browser;
  let first: string;
  let held: string;
  let t0: Date;

  /** A full release that the gate holds: a shippable Tor category on a known-good address (as spec 003 US1-2). */
  async function heldRelease(days: number, prefix: string): Promise<string> {
    const at = new Date(t0.getTime() + days * DAY);
    await seedRows(db.sql, { categories: [category({ prefix, code: "tor_exit", source: "tor-exit", from: new Date(at.getTime() - 3_600_000).toISOString() })] });
    const r = await buildAndRelease(db.sql, "full", { ...opts, at, now: at });
    if (r.status !== "held") throw new Error(`expected a held release, got ${r.status}`);
    return r.version;
  }

  beforeAll(async () => {
    tmp = await mkdtemp(join(tmpdir(), "foxtrust-011-us2-"));
    await loadFixtureFeeds(db.sql, ["x4bnet-datacenter"]);
    pub = await createTestPublication();
    t0 = new Date();
    opts = {
      dir: pub.dir, workDir: join(tmp, "work"), key: await loadSigningKey(pub.signingKeyPath),
      disputeUrl: "https://foxtrust.example/dispute", sample: 150, knownGoodFile: await knownGoodFile(tmp),
    };
    const r = await buildAndRelease(db.sql, "full", { ...opts, at: t0, now: t0 });
    if (r.status !== "published") throw new Error(`first release: ${r.status}`);
    first = r.version;
    held = await heldRelease(1, "9.9.9.9/32");
    oidc = await startFakeOidc();
    admin = await startTestAdmin({ sql: db.sql, oidc });
    op = (await signIn(admin, oidc)).browser;
  }, 300_000);

  afterAll(async () => {
    await admin?.stop();
    await oidc?.stop();
    await pub?.stop();
    if (tmp) await rm(tmp, { recursive: true, force: true });
  });

  const releasesPage = async () => (await op.get("/releases")).text();
  const rowOf = (html: string, version: string) => html.split("<tr>").find((r) => r.includes(`id="${version}"`)) ?? "";

  test("US2-1: the release list shows versions, kinds, times and status; a held one shows its regressions", async () => {
    const html = await releasesPage();
    expect(rowOf(html, first)).toContain("status-published");
    const heldRow = rowOf(html, held);
    expect(heldRow).toContain("status-held");
    expect(heldRow).toContain("full");
    expect(heldRow).toContain("FP rate at medium rose");
    expect(heldRow).toContain(`/releases/${held}/confirm`);
  });

  test("US2-2: a release request needs a note, is recorded with the operator, and cannot be doubled", async () => {
    const short = await op.post(`/releases/${held}/release`, { note: "too short" });
    expect(short.status).toBe(400);
    expect(await short.text()).toContain("10–1000 characters");
    expect(await db.sql`SELECT * FROM operator_request`).toHaveLength(0);

    const note = "Quad9 now carries a Tor exit category on purpose; verified by hand.";
    const ok = await op.post(`/releases/${held}/release`, { note });
    expect(ok.status).toBe(303);
    const [request] = (await db.sql`SELECT kind, target, note, requested_by_subject, state FROM operator_request`) as Record<string, string>[];
    expect(request).toEqual({ kind: "release", target: held, note, requested_by_subject: "operator-1", state: "requested" });
    expect(rowOf(await releasesPage(), held)).toContain("release requested");
    const [audited] = (await db.sql`SELECT action, item, note FROM admin_audit WHERE action = 'release.request'`) as Record<string, string>[];
    expect(audited).toEqual({ action: "release.request", item: held, note });

    const twice = await op.post(`/releases/${held}/release`, { note });
    expect(twice.status).toBe(400);
    expect(await twice.text()).toContain("already pending");
  });

  test("US2-3: the scheduler's pass publishes the release with the note; a request that cannot be carried out fails with the reason", async () => {
    const at = new Date(t0.getTime() + 2 * DAY);
    const done = await runOperatorRequests({ sql: db.sql, release: opts, clock: () => at });
    expect(done.map((r) => [r.target, r.state])).toEqual([[held, "done"]]);
    const [row] = (await db.sql`SELECT status, release_note FROM snapshot_release WHERE version = ${held}`) as { status: string; release_note: string }[];
    expect(row).toEqual({ status: "published", release_note: expect.stringContaining("Quad9") });
    expect(rowOf(await releasesPage(), held)).toContain("status-published");

    // Published by another path (the command line) after the request: the pass reports why it failed.
    const other = await heldRelease(3, "149.112.112.112/32");
    const note = "Second Quad9 address carries a Tor exit category on purpose.";
    expect((await op.post(`/releases/${other}/release`, { note })).status).toBe(303);
    await publishStaged(db.sql, other, { ...opts, releaseNote: "published from the command line" });
    const failed = await runOperatorRequests({ sql: db.sql, release: opts, clock: () => at });
    expect(failed.map((r) => [r.target, r.state])).toEqual([[other, "failed"]]);
    expect(failed[0]!.result).toContain("already published");
    expect(await releasesPage()).toContain("already published");
  });

  test("US2-4: a request for a release that is not held, or does not exist, is refused and nothing is recorded", async () => {
    const before = ((await db.sql`SELECT count(*)::int AS n FROM operator_request`) as { n: number }[])[0]!.n;
    const note = "This note is long enough to pass the length check.";
    for (const version of [first, "f20990101"]) {
      const res = await op.post(`/releases/${version}/release`, { note });
      expect({ version, status: res.status }).toEqual({ version, status: 400 });
    }
    const after = ((await db.sql`SELECT count(*)::int AS n FROM operator_request`) as { n: number }[])[0]!.n;
    expect(after).toBe(before);
  });
});
