import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activateConfig } from "../../src/db/versions";
import { readLicence } from "../../src/ingest/licence-gate";
import { runFeed, confirmHeldRun, type RunOptions, type RunReport } from "../../src/ingest/run";
import { runRetention } from "../../src/retention/retention";
import { createIpTrust } from "../../src/lookup/lookup";
import type { Reason, Verdict } from "../../src/model/types";
import { describeDb, resetData, withTestDb } from "../helpers/db";
import { shippedConfig } from "../helpers/seed";

const FIX = join(import.meta.dir, "..", "fixtures", "feeds");
const WIKI = join(import.meta.dir, "..", "..", "docs", "wiki", "entities");
const f = (feed: string, name: string) => join(FIX, feed, name);

const FILES: Record<string, string[]> = {
  iptoasn: [f("iptoasn", "ip2asn-combined.tsv.gz")],
  "x4bnet-datacenter": [f("x4bnet-datacenter", "ipv4.txt"), f("x4bnet-datacenter", "ipv6.txt")],
  "tor-exit": [f("tor-exit", "exit-list.txt")],
  "cymru-fullbogons": [f("cymru-fullbogons", "fullbogons-ipv4.txt"), f("cymru-fullbogons", "fullbogons-ipv6.txt")],
  "spamhaus-drop": [f("spamhaus-drop", "drop_v4.json"), f("spamhaus-drop", "drop_v6.json")],
  "feodo-tracker": [f("feodo-tracker", "ipblocklist.json")],
  "blocklist-de": [f("blocklist-de", "ssh.txt"), f("blocklist-de", "bruteforcelogin.txt")],
};

// Sample addresses, read straight from the fixture text.
const text = (path: string) => Bun.file(path).text();
const lines = async (path: string) => (await text(path)).split(/\r?\n/).filter((l) => l.trim() !== "" && !l.startsWith("#"));
const exitAddresses = async (path: string) =>
  (await lines(path)).filter((l) => l.startsWith("ExitAddress")).map((l) => l.split(/\s+/)[1]!);
const hostOf = (cidr: string) => cidr.split("/")[0]!;

type Samples = Awaited<ReturnType<typeof loadSamples>>;
async function loadSamples() {
  const tor = await exitAddresses(FILES["tor-exit"]![0]!);
  const shrunk = new Set(await exitAddresses(f("tor-exit", "shrunk.txt")));
  const x4v4 = await lines(f("x4bnet-datacenter", "ipv4.txt"));
  const x4v6 = await lines(f("x4bnet-datacenter", "ipv6.txt"));
  const ssh = await lines(f("blocklist-de", "ssh.txt"));
  const drop4 = (await lines(f("spamhaus-drop", "drop_v4.json"))).map((l) => JSON.parse(l)).filter((r) => r.cidr);
  const drop6 = (await lines(f("spamhaus-drop", "drop_v6.json"))).map((l) => JSON.parse(l)).filter((r) => r.cidr);
  const feodo = JSON.parse(await text(f("feodo-tracker", "ipblocklist.json")))[0];
  const cymru6 = await lines(f("cymru-fullbogons", "fullbogons-ipv6.txt"));
  return {
    tor: tor[0]!,
    torNotInShrunk: tor.find((ip) => !shrunk.has(ip))!,
    x4: { 4: x4v4, 6: x4v6 },
    ssh: { 4: ssh.find((l) => !l.includes(":"))!, 6: ssh.find((l) => l.includes(":"))! },
    drop: { 4: hostOf(drop4[0].cidr), 6: hostOf(drop6[0].cidr) },
    cymru: { 4: "0.0.0.1", 6: hostOf(cymru6[1]!) },
    feodo: { ip: feodo.ip_address as string, observedAt: new Date(`${feodo.last_online}T00:00:00Z`).toISOString() },
  };
}

describeDb("US2: licence-gated ingestion of reliable feeds", () => {
  const db = withTestDb();
  let tmp: string;
  let wikiRoot: string;
  let s: Samples;

  beforeAll(async () => {
    tmp = await mkdtemp(join(tmpdir(), "foxtrust-us2-"));
    wikiRoot = join(tmp, "wiki");
    for await (const name of new Bun.Glob("*.md").scan({ cwd: WIKI })) {
      await Bun.write(join(wikiRoot, name), Bun.file(join(WIKI, name)));
    }
    s = await loadSamples();
  });
  afterAll(async () => {
    await rm(tmp, { recursive: true, force: true });
  });
  beforeEach(async () => {
    await resetData(db.sql);
    await activateConfig(db.sql, await shippedConfig());
  });

  const ingest = (feed: string, files: string[] = FILES[feed]!, extra: Partial<RunOptions> = {}): Promise<RunReport> =>
    runFeed(db.sql, feed, { fromFiles: files, wikiRoot, artifactRoot: join(tmp, "artifacts"), ...extra });
  const ingestAll = async () => {
    const reports: RunReport[] = [];
    for (const feed of Object.keys(FILES)) reports.push(await ingest(feed));
    return reports;
  };
  const lookup = async (ip: string, at?: Date): Promise<Verdict> => {
    const client = createIpTrust({ databaseUrl: db.url });
    try {
      const result = await client.lookup(ip, at ? { at } : {});
      if (!result.ok) throw new Error(`lookup ${ip}: ${JSON.stringify(result.error)}`);
      return result.verdict;
    } finally {
      await client.close();
    }
  };
  const reason = (v: Verdict, code: string, source: string): Reason | undefined =>
    v.reasons.find((r) => r.code === code && r.source === source);
  const committedAt = async (runId: number | null) => {
    const [row] = await db.sql`SELECT committed_at FROM feed_run WHERE id = ${runId}`;
    return new Date(row.committed_at);
  };
  const writeTemp = async (name: string, content: string | Uint8Array) => {
    const path = join(tmp, crypto.randomUUID(), name);
    await Bun.write(path, content);
    return path;
  };

  // ---------------------------------------------------------------- US2-1
  test("US2-1: every feed with a licence is ingested into signals with kind, code, source and times (IPv4)", async () => {
    const reports = await ingestAll();
    expect(reports.map((r) => r.status)).toEqual(Array(7).fill("applied"));

    const checks: [string, string, string, string][] = [
      [s.tor, "tor_exit", "tor-exit", "category"],
      [hostOf(s.x4[4][0]!), "hosting", "x4bnet-datacenter", "category"],
      [s.cymru[4], "bogon", "cymru-fullbogons", "category"],
      [s.drop[4], "hijacked_netblock", "spamhaus-drop", "behavior"],
      [s.feodo.ip, "botnet_c2", "feodo-tracker", "behavior"],
      [s.ssh[4], "ssh_bruteforce", "blocklist-de", "behavior"],
    ];
    for (const [ip, code, source, kind] of checks) {
      const r = reason(await lookup(ip), code, source);
      expect(r, `${ip} should have ${code} from ${source}`).toBeDefined();
      expect(r!.kind).toBe(kind as Reason["kind"]);
      expect(Date.parse(r!.firstSeen)).toBeLessThanOrEqual(Date.parse(r!.lastSeen));
    }
    const network = (await lookup("1.0.0.1")).network;
    expect(network).toEqual({ asn: 13335, org: "CLOUDFLARENET", prefix: "1.0.0.0/24", country: "US" });

    const [{ n }] = await db.sql`SELECT count(*)::int AS n FROM category_interval WHERE source = 'tor-exit'`;
    expect(n).toBe(reports.find((r) => r.feed === "tor-exit")!.entryCount!);
  });

  test("US2-1: every feed with a licence is ingested into signals with kind, code, source and times (IPv6)", async () => {
    await ingestAll();
    const checks: [string, string, string][] = [
      [hostOf(s.x4[6][0]!), "hosting", "x4bnet-datacenter"],
      [s.cymru[6], "bogon", "cymru-fullbogons"],
      [s.drop[6], "hijacked_netblock", "spamhaus-drop"],
      [s.ssh[6], "ssh_bruteforce", "blocklist-de"],
    ];
    for (const [ip, code, source] of checks) {
      expect(reason(await lookup(ip), code, source), `${ip} should have ${code}`).toBeDefined();
    }
    const [v6row] = await db.sql`
      SELECT prefix::text AS prefix, asn FROM network_interval WHERE family(prefix) = 6 ORDER BY prefix LIMIT 1`;
    expect((await lookup(hostOf(v6row.prefix))).network.prefix).not.toBeNull();
  });

  // ---------------------------------------------------------------- US2-2
  for (const [family, feed, ip, code] of [
    [4, "blocklist-de", () => s.ssh[4], "ssh_bruteforce"],
    [6, "x4bnet-datacenter", () => hostOf(s.x4[6][0]!), "hosting"],
  ] as const) {
    test(`US2-2: a feed without a licence page is skipped and the others still run (IPv${family})`, async () => {
      const partialWiki = join(tmp, `wiki-without-${feed}`);
      for await (const name of new Bun.Glob("*.md").scan({ cwd: wikiRoot })) {
        if (name !== `${feed}.md`) await Bun.write(join(partialWiki, name), Bun.file(join(wikiRoot, name)));
      }
      const skipped = await ingest(feed, FILES[feed], { wikiRoot: partialWiki });
      const other = await ingest("tor-exit", FILES["tor-exit"], { wikiRoot: partialWiki });
      expect(skipped.status).toBe("licence_missing");
      expect(skipped.error).toContain("no licence page");
      expect(other.status).toBe("applied");
      expect((await lookup(ip())).reasons.some((r) => r.code === code)).toBe(false);
      const [run] = await db.sql`SELECT status FROM feed_run WHERE id = ${skipped.runId}`;
      expect(run.status).toBe("licence_missing");
    });
  }

  // ---------------------------------------------------------------- US2-3
  test("US2-3: signals from local-only feeds are not shippable and the report lists them (IPv4)", async () => {
    await ingestAll();
    expect(reason(await lookup(s.cymru[4]), "bogon", "cymru-fullbogons")!.shippable).toBe(false);
    expect(reason(await lookup(s.tor), "tor_exit", "tor-exit")!.shippable).toBe(true);
    // Unknown terms, shipped by decision (`ship: yes`, constitution v5.0.0).
    expect(reason(await lookup(s.ssh[4]), "ssh_bruteforce", "blocklist-de")!.shippable).toBe(true);
    const rows = await db.sql`
      SELECT source, bool_or(shippable) AS any_shippable FROM (
        SELECT source, shippable FROM category_interval UNION ALL SELECT source, shippable FROM behavior_sighting
        UNION ALL SELECT source, shippable FROM behavior_daily) x GROUP BY source ORDER BY source`;
    expect(Object.fromEntries(rows.map((r: { source: string; any_shippable: boolean }) => [r.source, r.any_shippable]))).toEqual({
      "blocklist-de": true, "cymru-fullbogons": false, "feodo-tracker": true, "spamhaus-drop": true,
      "tor-exit": true, "x4bnet-datacenter": true,
    });

    const proc = Bun.spawn(["bun", "run", "src/cli/main.ts", "feeds", "status", "--json"], {
      env: { ...Bun.env, DATABASE_URL: db.url }, stdout: "pipe", stderr: "pipe",
    });
    expect(await proc.exited).toBe(0);
    const status = JSON.parse(await new Response(proc.stdout).text()) as { feeds: { feed: string; licence: string; licenceChecked: string | null }[] };
    const localOnly = status.feeds.filter((x) => x.licence === "local-only").map((x) => x.feed).sort();
    expect(localOnly).toEqual(["cymru-fullbogons"]);
    for (const feed of status.feeds.filter((f) => f.feed in FILES)) {
      expect(feed.licenceChecked).toEqual((await readLicence(feed.feed, wikiRoot)).checked); // date from the licence record
    }
  });

  test("US2-3: signals from local-only feeds are not shippable and the report lists them (IPv6)", async () => {
    await ingestAll();
    expect(reason(await lookup(s.cymru[6]), "bogon", "cymru-fullbogons")!.shippable).toBe(false);
    expect(reason(await lookup(hostOf(s.x4[6][0]!)), "hosting", "x4bnet-datacenter")!.shippable).toBe(true);
    expect(reason(await lookup(s.ssh[6]), "ssh_bruteforce", "blocklist-de")!.shippable).toBe(true);
  });

  // ---------------------------------------------------------------- US2-4
  test("US2-4: a failed or unparsable update keeps the previous data and marks the feed stale (IPv4)", async () => {
    await ingest("tor-exit");
    const [{ before }] = await db.sql`SELECT count(*)::int AS before FROM category_interval WHERE upper_inf(valid)`;

    const broken = await ingest("tor-exit", [f("tor-exit", "malformed.txt")]);
    expect(broken.status).toBe("failed");
    expect(broken.error).toStartWith("parse_error");
    const unreachable = await ingest("tor-exit", [], { fromFiles: [], urls: { "exit-list.txt": "http://127.0.0.1:9/exit" }, allowLoopbackHttp: true });
    expect(unreachable.status).toBe("failed");
    expect(unreachable.error).toStartWith("network_error");

    const [{ after }] = await db.sql`SELECT count(*)::int AS after FROM category_interval WHERE upper_inf(valid)`;
    expect(after).toBe(before);
    expect(reason(await lookup(s.tor), "tor_exit", "tor-exit")).toBeDefined(); // SC-006
    const [feed] = await db.sql`SELECT stale, last_error, last_success_at, last_attempt_at FROM feed WHERE id = 'tor-exit'`;
    expect(feed.stale).toBe(true);
    expect(feed.last_error).toStartWith("network_error");
    expect(new Date(feed.last_attempt_at).getTime()).toBeGreaterThan(new Date(feed.last_success_at).getTime());
  });

  test("US2-4: a failed or unparsable update keeps the previous data and marks the feed stale (IPv6)", async () => {
    await ingest("x4bnet-datacenter");
    const failed = await ingest("x4bnet-datacenter", [], {
      fromFiles: [],
      urls: { "ipv4.txt": "http://127.0.0.1:9/ipv4.txt", "ipv6.txt": "http://127.0.0.1:9/ipv6.txt" },
      allowLoopbackHttp: true,
    });
    expect(failed.status).toBe("failed");
    expect(reason(await lookup(hostOf(s.x4[6][0]!)), "hosting", "x4bnet-datacenter")).toBeDefined();
    const [feed] = await db.sql`SELECT stale FROM feed WHERE id = 'x4bnet-datacenter'`;
    expect(feed.stale).toBe(true);
  });

  // ---------------------------------------------------------------- US2-5
  test("US2-5: a shrunk update is held until the operator confirms it (IPv4)", async () => {
    await ingest("tor-exit");
    const held = await ingest("tor-exit", [f("tor-exit", "shrunk.txt")]);
    expect(held.status).toBe("held");
    expect(held.error).toContain("feeds confirm");
    expect(reason(await lookup(s.torNotInShrunk), "tor_exit", "tor-exit")).toBeDefined();

    const confirmed = await confirmHeldRun(db.sql, held.runId!, { wikiRoot });
    expect(confirmed.status).toBe("applied");
    const [run] = await db.sql`SELECT status, confirmed_at FROM feed_run WHERE id = ${held.runId}`;
    expect(run.status).toBe("applied");
    expect(run.confirmed_at).not.toBeNull();
    expect(reason(await lookup(s.torNotInShrunk), "tor_exit", "tor-exit")).toBeUndefined();
  });

  test("US2-5: a shrunk update is held until the operator confirms it (IPv6)", async () => {
    await ingest("x4bnet-datacenter");
    const v4 = await writeTemp("ipv4.txt", s.x4[4].slice(0, 100).join("\n"));
    const v6 = await writeTemp("ipv6.txt", s.x4[6].slice(0, 100).join("\n"));
    const dropped = hostOf(s.x4[6][300]!);
    const held = await ingest("x4bnet-datacenter", [v4, v6]);
    expect(held.status).toBe("held");
    expect(reason(await lookup(dropped), "hosting", "x4bnet-datacenter")).toBeDefined();
    await confirmHeldRun(db.sql, held.runId!, { wikiRoot });
    expect(reason(await lookup(dropped), "hosting", "x4bnet-datacenter")).toBeUndefined();
  });

  // ---------------------------------------------------------------- US2-6
  for (const family of [4, 6] as const) {
    test(`US2-6: a prefix that leaves a category feed is closed at that run; history stays (IPv${family})`, async () => {
      const list = s.x4[family];
      const removed = list[10]!;
      const v2 = family === 4
        ? [f("x4bnet-datacenter", "ipv4.v2.txt"), f("x4bnet-datacenter", "ipv6.txt")]
        : [f("x4bnet-datacenter", "ipv4.txt"), await writeTemp("ipv6.v2.txt", list.filter((_, i) => i < 10 || i >= 20).join("\n"))];

      await ingest("x4bnet-datacenter");
      const run2 = await ingest("x4bnet-datacenter", v2);
      const closedAt = await committedAt(run2.runId);
      // committed_at has microseconds; a JS Date has milliseconds, so "just after" is +1 ms.
      const afterClose = new Date(closedAt.getTime() + 1);
      const ip = hostOf(removed);

      expect(reason(await lookup(ip, new Date(closedAt.getTime() - 1)), "hosting", "x4bnet-datacenter")).toBeDefined();
      expect(reason(await lookup(ip, afterClose), "hosting", "x4bnet-datacenter")).toBeUndefined();

      await ingest("x4bnet-datacenter"); // listed again → new interval
      const rows = await db.sql`
        SELECT upper_inf(valid) AS open, upper(valid) AS closed_at FROM category_interval
        WHERE prefix = ${removed}::cidr ORDER BY lower(valid)`;
      expect(rows.map((r: { open: boolean }) => r.open)).toEqual([false, true]);
      expect(new Date(rows[0].closed_at).getTime()).toBe(closedAt.getTime()); // closed at run 2 (to the ms)
      expect(reason(await lookup(ip), "hosting", "x4bnet-datacenter")).toBeDefined();
      expect(reason(await lookup(ip, afterClose), "hosting", "x4bnet-datacenter")).toBeUndefined(); // the gap is kept
    });
  }

  test("US2-6: a network whose ASN changes is closed and reopened (IPv4)", async () => {
    await ingest("iptoasn");
    const run2 = await ingest("iptoasn", [f("iptoasn", "ip2asn-combined.v2.tsv.gz")]);
    const changedAt = await committedAt(run2.runId);
    expect((await lookup("1.0.0.1", new Date(changedAt.getTime() - 1))).network.asn).toBe(13335);
    expect((await lookup("1.0.0.1")).network).toMatchObject({ asn: 64496, org: "EXAMPLE-RENUMBERED" });
  });

  test("US2-6: a network whose ASN changes is closed and reopened (IPv6)", async () => {
    const original = Bun.gunzipSync(new Uint8Array(await Bun.file(FILES.iptoasn![0]!).arrayBuffer()));
    const rows = new TextDecoder().decode(original).split("\n");
    const index = rows.findIndex((r) => r.split("\t")[0]!.includes(":") && Number(r.split("\t")[2]) > 0);
    const fields = rows[index]!.split("\t");
    const ip = fields[0]!;
    rows[index] = [fields[0], fields[1], "64497", fields[3], "EXAMPLE-RENUMBERED-V6"].join("\t");
    const v2 = await writeTemp("ip2asn-combined.tsv.gz", Bun.gzipSync(new TextEncoder().encode(rows.join("\n"))));

    await ingest("iptoasn");
    const run2 = await ingest("iptoasn", [v2]);
    const changedAt = await committedAt(run2.runId);
    expect((await lookup(ip, new Date(changedAt.getTime() - 1))).network.asn).toBe(Number(fields[2]));
    expect((await lookup(ip)).network).toMatchObject({ asn: 64497, org: "EXAMPLE-RENUMBERED-V6" });
  });

  // ---------------------------------------------------------------- US2-7
  for (const family of [4, 6] as const) {
    test(`US2-7: an address that leaves a behavior feed keeps its lastSeen and decays (IPv${family})`, async () => {
      const ip = s.ssh[family];
      const sshLines = await lines(f("blocklist-de", "ssh.txt"));
      const v2 = family === 4
        ? f("blocklist-de", "ssh.v2.txt")
        : await writeTemp("ssh.v2.txt", sshLines.filter((l) => !l.includes(":")).join("\n"));
      const bfl = f("blocklist-de", "bruteforcelogin.txt");

      const run1 = await ingest("blocklist-de");
      const run2 = await ingest("blocklist-de", [v2, bfl]);
      expect(run2.status).toBe("applied");
      const seen1 = await committedAt(run1.runId);

      const [episode] = await db.sql`SELECT open FROM behavior_sighting WHERE prefix = ${`${ip}/${family === 4 ? 32 : 128}`}::cidr AND code = 'ssh_bruteforce'`;
      expect(episode.open).toBe(false);
      const later = reason(await lookup(ip), "ssh_bruteforce", "blocklist-de");
      expect(later).toBeDefined();
      expect(later!.lastSeen).toBe(seen1.toISOString());

      const run3 = await ingest("blocklist-de"); // listed again → a new episode
      const episodes = await db.sql`SELECT count(*)::int AS n FROM behavior_sighting WHERE prefix = ${`${ip}/${family === 4 ? 32 : 128}`}::cidr AND code = 'ssh_bruteforce'`;
      expect(episodes[0].n).toBe(2);
      expect(reason(await lookup(ip), "ssh_bruteforce", "blocklist-de")!.lastSeen).toBe((await committedAt(run3.runId)).toISOString());
    });
  }

  test("US2-7: feed-provided times are kept as observations (IPv4)", async () => {
    await ingest("feodo-tracker");
    await ingest("feodo-tracker");
    const [{ n, feed_time }] = await db.sql`
      SELECT count(*)::int AS n, bool_and(feed_time) AS feed_time FROM behavior_sighting WHERE source = 'feodo-tracker'`;
    const entries = JSON.parse(await text(f("feodo-tracker", "ipblocklist.json"))).length;
    expect(n).toBe(entries);
    expect(feed_time).toBe(true);
    expect(reason(await lookup(s.feodo.ip), "botnet_c2", "feodo-tracker")!.lastSeen).toBe(s.feodo.observedAt);
  });

  // ---------------------------------------------------------------- US2-8
  for (const family of [4, 6] as const) {
    test(`US2-8: retention removes old raw rows and aggregates without changing the current verdict (IPv${family})`, async () => {
      const ip = s.ssh[family];
      const run = await ingest("blocklist-de");
      const future = new Date(Date.now() + 100 * 86_400_000);
      const dayAgo = (days: number) => new Date(future.getTime() - days * 86_400_000).toISOString().slice(0, 10);
      const other = family === 4 ? "198.18.0.1/32" : "2001:2::1/128";
      for (const days of [460, 400]) {
        await db.sql`
          INSERT INTO behavior_daily (prefix, code, source, day, count, first_seen, last_seen, shippable)
          VALUES (${other}::cidr, 'ssh_bruteforce', 'blocklist-de', ${dayAgo(days)}::date, 1,
                  ${dayAgo(days)}::timestamptz, ${dayAgo(days)}::timestamptz, false)`;
      }
      const [artifact] = await db.sql`SELECT artifact_path FROM feed_run WHERE id = ${run.runId}`;
      expect(await Bun.file(join(artifact.artifact_path, "ssh.txt.gz")).exists()).toBe(true);

      const before = await lookup(ip, future);
      const report = await runRetention(db.sql, future);
      const after = await lookup(ip, future);

      expect(report.rawDeleted).toBeGreaterThan(0);
      const [{ raw }] = await db.sql`SELECT count(*)::int AS raw FROM behavior_sighting`;
      expect(raw).toBe(0);
      const days = await db.sql`SELECT day::text AS day FROM behavior_daily WHERE prefix = ${other}::cidr ORDER BY day`;
      expect(days.map((d: { day: string }) => d.day)).toEqual([dayAgo(400)]);
      expect(await Bun.file(join(artifact.artifact_path, "ssh.txt.gz")).exists()).toBe(false);
      const [{ path }] = await db.sql`SELECT artifact_path AS path FROM feed_run WHERE id = ${run.runId}`;
      expect(path).toBeNull();
      const [dv] = await db.sql`SELECT cause FROM data_version ORDER BY id DESC LIMIT 1`;
      expect(dv.cause).toBe("retention");

      expect(reason(before, "ssh_bruteforce", "blocklist-de")).toBeDefined();
      const { dataVersion: _a, ...beforeRest } = before;
      const { dataVersion: _b, ...afterRest } = after;
      expect(afterRest).toEqual(beforeRest); // FR-030
    });
  }

  // ---------------------------------------------------------------- US2-9
  for (const family of [4, 6] as const) {
    test(`US2-9: the same content twice creates no duplicates and refreshes lastSeen (IPv${family})`, async () => {
      const category = family === 4 ? "tor-exit" : "x4bnet-datacenter";
      const categoryPrefix = family === 4 ? `${s.tor}/32` : s.x4[6][0]!;
      const behaviorPrefix = `${s.ssh[family]}/${family === 4 ? 32 : 128}`;

      await ingest(category);
      await ingest("blocklist-de");
      const counts = async () => (await db.sql`
        SELECT (SELECT count(*)::int FROM category_interval) AS c, (SELECT count(*)::int FROM behavior_sighting) AS b`)[0];
      const lastSeen = async () => (await db.sql`
        SELECT (SELECT last_seen FROM category_interval WHERE prefix = ${categoryPrefix}::cidr AND upper_inf(valid)) AS c,
               (SELECT last_seen FROM behavior_sighting WHERE prefix = ${behaviorPrefix}::cidr AND open AND code = 'ssh_bruteforce') AS b`)[0];
      const before = await counts();
      const seenBefore = await lastSeen();

      const again = [await ingest(category), await ingest("blocklist-de")];
      expect(again.map((r) => r.status)).toEqual(["unchanged", "unchanged"]);
      expect(await counts()).toEqual(before);
      const seenAfter = await lastSeen();
      expect(new Date(seenAfter.c).getTime()).toBeGreaterThan(new Date(seenBefore.c).getTime());
      expect(new Date(seenAfter.b).getTime()).toBeGreaterThan(new Date(seenBefore.b).getTime());
      const [episode] = await db.sql`SELECT sightings FROM behavior_sighting WHERE prefix = ${behaviorPrefix}::cidr AND open AND code = 'ssh_bruteforce'`;
      expect(episode.sightings).toBe(2);
    });
  }
});
