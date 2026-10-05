import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Reader } from "mmdb-lib";
import { resolveVersionAt } from "../../src/db/versions";
import { DEFAULT_WIKI_ENTITIES } from "../../src/ingest/licence-gate";
import { runFeed } from "../../src/ingest/run";
import { formatIp, toIpValue, type IpValue } from "../../src/ip/parse";
import { gatherSignals } from "../../src/lookup/signals";
import { buildFull, SNAPSHOT_DB_TYPE } from "../../src/snapshot/build";
import { buildAndRelease, stagedRangeTable, type ReleaseOptions } from "../../src/snapshot/publish";
import { customerRecord, deserializeRanges, type Range } from "../../src/snapshot/ranges";
import { importTrustedKeys, loadSigningKey, verify } from "../../src/snapshot/sign";
import { describeDb, withTestDb } from "../helpers/db";
import { FIXTURE_FILES, fixturePath, loadFixtureDataset } from "../helpers/fixture-data";
import { createTestPublication, type TestPublication } from "../helpers/publication";

type SnapshotRecord = {
  risk: number;
  level: string;
  categories: string[];
  reasons: { code: string; last_seen: number; contribution: number }[];
  network: { asn?: number; org?: string; country?: string };
  removed?: boolean;
};

const lines = async (path: string) => (await Bun.file(path).text()).split(/\r?\n/).filter((l) => l.trim() !== "" && !l.startsWith("#"));
const hostOf = (cidr: string) => cidr.split("/")[0]!;
const ip = (text: string): IpValue => {
  const v = toIpValue(text);
  if ("error" in v) throw new Error(v.error);
  return v;
};
// mmdb-lib types its results as the MaxMind products; ours is a custom database type.
const readerOf = (bytes: Uint8Array) => {
  const reader = new Reader(Buffer.from(bytes));
  return { metadata: reader.metadata, get: (address: string) => reader.get(address) as unknown as SnapshotRecord | null };
};
const fileBytes = async (path: string) => new Uint8Array(await Bun.file(path).arrayBuffer());

// Addresses inside X4BNet hosting prefixes that we also list in the blocklist-de file.
const HOSTING_AND_SSH = { 4: "1.12.0.9", 6: "2001:310::9" } as const;
// The first Tor exit moves into a hosting prefix in the "Tor change" of US1-4.
const TOR_MOVED_TO = "1.12.0.5";

describeDb("US1: signed snapshot readable by any MMDB reader", () => {
  const db = withTestDb();
  let tmp: string;
  let pub: TestPublication;
  let opts: ReleaseOptions;
  let full: { version: string; path: string; builtAt: Date; bytes: Uint8Array };
  let behaviorFiles: Record<string, string[]>;
  let samples: {
    tor: string;
    x4v6: string;
    localOnly: string[];
    unallocatedV6: string;
    cymru: string[];
  };

  /** The customer record computed straight from the stored signals (the reference). */
  async function expected(address: string, at: Date) {
    const version = await resolveVersionAt(db.sql, at);
    const { signals, network } = await gatherSignals(db.sql, ip(address), at);
    return customerRecord(signals, network, version!.config, at);
  }

  beforeAll(async () => {
    tmp = await mkdtemp(join(tmpdir(), "foxtrust-us1-"));
    const ssh = fixturePath("blocklist-de", "ssh.txt");
    const sshPlus = join(tmp, "ssh.txt");
    await Bun.write(sshPlus, `${await Bun.file(ssh).text()}\n${HOSTING_AND_SSH[4]}\n${HOSTING_AND_SSH[6]}\n`);
    behaviorFiles = {
      "blocklist-de": [sshPlus, fixturePath("blocklist-de", "bruteforcelogin.txt")],
      "feodo-tracker": FIXTURE_FILES["feodo-tracker"]!.map((n) => fixturePath("feodo-tracker", n)),
      "spamhaus-drop": FIXTURE_FILES["spamhaus-drop"]!.map((n) => fixturePath("spamhaus-drop", n)),
    };
    await loadFixtureDataset(db.sql, { "blocklist-de": behaviorFiles["blocklist-de"]! });

    const torLines = await lines(fixturePath("tor-exit", "exit-list.txt"));
    const sshLines = await lines(ssh);
    const drop4 = (await lines(fixturePath("spamhaus-drop", "drop_v4.json"))).map((l) => JSON.parse(l)).filter((r) => r.cidr);
    const drop6 = (await lines(fixturePath("spamhaus-drop", "drop_v6.json"))).map((l) => JSON.parse(l)).filter((r) => r.cidr);
    const feodo = JSON.parse(await Bun.file(fixturePath("feodo-tracker", "ipblocklist.json")).text());
    const cymru4 = await lines(fixturePath("cymru-fullbogons", "fullbogons-ipv4.txt"));
    const cymru6 = await lines(fixturePath("cymru-fullbogons", "fullbogons-ipv6.txt"));
    samples = {
      tor: torLines.find((l) => l.startsWith("ExitAddress"))!.split(/\s+/)[1]!,
      x4v6: `${hostOf((await lines(fixturePath("x4bnet-datacenter", "ipv6.txt")))[1]!)}1`,
      localOnly: [
        sshLines.find((l) => !l.includes(":"))!,
        sshLines.find((l) => l.includes(":"))!,
        hostOf(drop4[0].cidr),
        hostOf(drop6[0].cidr),
        ...feodo.slice(0, 3).map((r: { ip_address: string }) => r.ip_address),
        HOSTING_AND_SSH[4],
        HOSTING_AND_SSH[6],
      ],
      unallocatedV6: "2000::1",
      cymru: [...cymru4.slice(0, 40), ...cymru6.slice(0, 40)].map(hostOf),
    };

    pub = await createTestPublication();
    opts = {
      dir: pub.dir,
      workDir: join(tmp, "work"),
      key: await loadSigningKey(pub.signingKeyPath),
      disputeUrl: "https://foxtrust.example/dispute",
      sample: 400,
    };
    const at = new Date();
    const result = await buildAndRelease(db.sql, "full", { ...opts, at, now: at });
    if (result.status !== "published") throw new Error(`full release: ${result.status} ${JSON.stringify(result)}`);
    full = { version: result.version, path: result.path!, builtAt: at, bytes: await fileBytes(join(pub.dir, result.path!)) };
  }, 180_000);

  afterAll(async () => {
    await pub?.stop();
    if (tmp) await rm(tmp, { recursive: true, force: true });
  });

  test("US1-1: a standard MMDB reader returns customer records (IPv4/IPv6)", async () => {
    const reader = readerOf(full.bytes);
    expect(reader.metadata.databaseType).toBe(SNAPSHOT_DB_TYPE);
    expect(reader.metadata.ipVersion).toBe(6);

    const tor = reader.get(samples.tor);
    expect(tor?.categories).toContain("tor");
    expect(tor?.reasons.map((r) => r.code)).toContain("tor_exit");
    expect(tor).toEqual((await expected(samples.tor, full.builtAt)) as SnapshotRecord);

    const hosting = reader.get(samples.x4v6);
    expect(hosting?.categories).toContain("hosting");
    expect(hosting).toEqual((await expected(samples.x4v6, full.builtAt)) as SnapshotRecord);

    for (const record of [tor!, hosting!]) {
      expect(Object.keys(record).sort()).toEqual(["categories", "level", "network", "reasons", "risk"]);
      for (const reason of record.reasons) expect(Object.keys(reason).sort()).toEqual(["code", "contribution", "last_seen"]);
      expect(Object.keys(record.network).every((k) => ["asn", "org", "country"].includes(k))).toBe(true);
    }

    expect(reader.get("8.8.8.8")).toBeNull();
    expect(reader.get("2001:4860:4860::8888")).toBeNull();
  });

  test("US1-2: the file and its signature verify after download; one flipped byte fails", async () => {
    const res = await fetch(`${pub.url}/${full.path}`);
    const sig = await fetch(`${pub.url}/${full.path}.sig`);
    expect(res.status).toBe(200);
    expect(sig.status).toBe(200);
    const bytes = new Uint8Array(await res.arrayBuffer());
    const signature = new Uint8Array(await sig.arrayBuffer());
    const trusted = await importTrustedKeys([pub.publicKey]);
    expect(await verify(bytes, signature, trusted)).toEqual({ ok: true, keyId: pub.keyId });

    const flipped = bytes.slice();
    const middle = Math.floor(flipped.length / 2);
    flipped[middle] = flipped[middle]! ^ 0x01;
    expect((await verify(flipped, signature, trusted)).ok).toBe(false);

    const manifest = new Uint8Array(await (await fetch(`${pub.url}/v1/manifest.json`)).arrayBuffer());
    const manifestSig = new Uint8Array(await (await fetch(`${pub.url}/v1/manifest.json.sig`)).arrayBuffer());
    expect((await verify(manifest, manifestSig, trusted)).ok).toBe(true);
    const parsed = JSON.parse(new TextDecoder().decode(manifest));
    expect(parsed.full.version).toBe(full.version);
    expect(parsed.full.sha256).toBe(new Bun.CryptoHasher("sha256").update(bytes).digest("hex"));
    expect(parsed.disputeUrl).toBe("https://foxtrust.example/dispute");
    expect(parsed.notices.map((n: { source: string }) => n.source)).toContain("x4bnet-datacenter");
  });

  test("US1-5: unallocated IPv6 space and 10.1.2.3 are bogon; nothing comes from cymru-fullbogons (IPv4/IPv6)", async () => {
    const reader = readerOf(full.bytes);
    for (const address of [samples.unallocatedV6, "10.1.2.3"]) {
      expect(reader.get(address)?.categories).toContain("bogon");
    }
    // A cymru-only prefix is bogon only where our own IANA-based data says so.
    for (const address of samples.cymru) {
      const { signals } = await gatherSignals(db.sql, ip(address), full.builtAt);
      const ours = signals.some((s) => s.code === "bogon" && s.shippable);
      expect({ address, bogon: reader.get(address)?.categories.includes("bogon") ?? false }).toEqual({ address, bogon: ours });
    }
    const [row] = await db.sql`SELECT sources FROM snapshot_release WHERE version = ${full.version}`;
    expect(row.sources).not.toContain("cymru-fullbogons");
    expect(row.sources).toContain("iana-address-space");
  }, 60_000);

  test("US1-4: base plus the cumulative delta equals a fresh full snapshot after a Tor change (IPv4/IPv6)", async () => {
    // Tor change: the first exit address moves into an X4BNet hosting prefix.
    const exitList = await Bun.file(fixturePath("tor-exit", "exit-list.txt")).text();
    const changed = join(tmp, "exit-list.txt");
    await Bun.write(changed, exitList.replaceAll(`ExitAddress ${samples.tor} `, `ExitAddress ${TOR_MOVED_TO} `));
    const run = await runFeed(db.sql, "tor-exit", { fromFiles: [changed], artifactRoot: join(tmp, "artifacts") });
    expect(run.status).toBe("applied");

    const at = new Date();
    const delta = await buildAndRelease(db.sql, "delta", { ...opts, at, now: at });
    if (delta.status !== "published") throw new Error(`delta release: ${JSON.stringify(delta)}`);
    const base = readerOf(full.bytes);
    const overlay = readerOf(await fileBytes(join(pub.dir, delta.path!)));
    const fresh = await buildFull(db.sql, { at, disputeUrl: opts.disputeUrl });
    const freshReader = readerOf(fresh.bytes);
    const lookup = (address: string) => {
      const d = overlay.get(address);
      if (d) return d.removed ? null : d;
      return base.get(address);
    };

    // The removed exit has no network data, so the delta carries a tombstone for it.
    expect(overlay.get(samples.tor)).toEqual({ removed: true } as SnapshotRecord);
    expect(lookup(samples.tor)).toBeNull();
    expect(lookup(TOR_MOVED_TO)?.categories).toEqual(["hosting", "tor"]);

    // 5,000 addresses sampled from the ranges of both the base and the fresh snapshot.
    const ranges: Range[] = [
      ...deserializeRanges((await stagedRangeTable(opts.workDir, full.version))!),
      ...deserializeRanges(fresh.rangeTable),
    ];
    let seed = 7;
    const random = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    const mismatches: string[] = [];
    for (let i = 0; i < 5000; i++) {
      const r = ranges[Math.floor(random() * ranges.length)]!;
      const size = r.end - r.start + 1n;
      const value = r.start + (BigInt(Math.floor(random() * 2 ** 48)) % size);
      const address = formatIp({ family: r.family, value });
      const a = JSON.stringify(lookup(address));
      const b = JSON.stringify(freshReader.get(address));
      if (a !== b && mismatches.length < 5) mismatches.push(`${address}: ${a} ≠ ${b}`);
    }
    expect(mismatches).toEqual([]);
  }, 120_000);

  // Last: it withdraws the behavior feeds and deletes the local-only rows from the database.
  test("US1-3: local-only feeds do not change any customer record (IPv4/IPv6)", async () => {
    // The behavior feeds ship by decision (`ship: yes`); `ship: no` withdraws them, and their
    // next run marks every stored signal local-only (constitution v5.0.0).
    const wiki = join(tmp, "wiki-withdrawn");
    for await (const name of new Bun.Glob("*.md").scan({ cwd: DEFAULT_WIKI_ENTITIES })) {
      const text = await Bun.file(join(DEFAULT_WIKI_ENTITIES, name)).text();
      await Bun.write(join(wiki, name), text.replace(/^ship: yes$/m, "ship: no"));
    }
    for (const [feed, fromFiles] of Object.entries(behaviorFiles)) {
      const report = await runFeed(db.sql, feed, { fromFiles, wikiRoot: wiki, artifactRoot: join(tmp, "artifacts") });
      expect({ feed, licence: report.licence }).toEqual({ feed, licence: "local-only" });
    }

    const at = new Date();
    const reader = readerOf((await buildFull(db.sql, { at, disputeUrl: opts.disputeUrl })).bytes);
    const before = new Map<string, SnapshotRecord | null>();
    const onlyLocal: string[] = [];
    for (const address of samples.localOnly) {
      before.set(address, reader.get(address));
      const { signals, network } = await gatherSignals(db.sql, ip(address), at);
      const noNetwork = network.asn === null && network.org === null && network.country === null;
      if (noNetwork && signals.length > 0 && signals.every((s) => !s.shippable)) onlyLocal.push(address);
    }
    // Only blocklist-de, Spamhaus or Feodo signals and no network data: no record at all.
    expect(onlyLocal.length).toBeGreaterThan(0);
    for (const address of onlyLocal) expect({ address, record: before.get(address) }).toEqual({ address, record: null });
    // Hosting plus blocklist-de: hosting only.
    expect(before.get(HOSTING_AND_SSH[4])?.categories).toEqual(["hosting"]);
    expect(before.get(HOSTING_AND_SSH[6])?.categories).toEqual(["hosting"]);

    await db.sql`DELETE FROM behavior_sighting WHERE NOT shippable`;
    await db.sql`DELETE FROM behavior_daily WHERE NOT shippable`;
    await db.sql`DELETE FROM category_interval WHERE NOT shippable`;
    const clean = readerOf((await buildFull(db.sql, { at, disputeUrl: opts.disputeUrl })).bytes);
    for (const address of samples.localOnly) {
      expect({ address, record: before.get(address) }).toEqual({ address, record: clean.get(address) });
    }
  }, 60_000);
});
