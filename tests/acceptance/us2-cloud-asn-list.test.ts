import { beforeAll, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cloudFeed } from "../../src/feeds/ipverse-cloud";
import { runFeed } from "../../src/ingest/run";
import { describeDb, withTestDb } from "../helpers/db";
import { CLOUD_FILES, CLOUD_LIST, loadFixtureDataset } from "../helpers/fixture-data";

const HEADER = "asn,provider,status,source,added,reason";
const row = (asn: string, status = "include", source = `https://www.peeringdb.com/asn/${asn}`, reason = "") =>
  `${asn},Provider ${asn},${status},${source},2026-10-05,${reason}`;
const list = (...rows: string[]) => [HEADER, ...rows].join("\n");
const GOOD_ROWS = [row("16509"), row("396982"), row("8075"), row("20473"), row("15169", "exclude", undefined, "public DNS")];

describeDb("US2 (spec 005): the cloud list is reviewed data with sources", () => {
  const db = withTestDb();
  let artifacts: string;
  const run = (text: string, files = CLOUD_FILES) =>
    runFeed(db.sql, "ipverse-cloud", { definition: cloudFeed(text), fromFiles: files, artifactRoot: artifacts });
  const intervals = async () =>
    (await db.sql<{ prefix: string; open: boolean }[]>`
      SELECT prefix::text AS prefix, upper_inf(valid) AS open FROM category_interval
      WHERE source = 'ipverse-cloud' ORDER BY prefix, lower(valid)`).map((r) => `${r.prefix}:${r.open}`);
  const openPrefixes = async () =>
    (await db.sql<{ prefix: string }[]>`
      SELECT prefix::text AS prefix FROM category_interval WHERE source = 'ipverse-cloud' AND upper_inf(valid)`).map((r) => r.prefix);
  const prefixesOf = async (asn: number) =>
    ((await Bun.file(CLOUD_FILES.find((f) => f.endsWith(`as${asn}.json`))!).json()) as { prefixes: { ipv4: string[] } }).prefixes.ipv4;

  beforeAll(async () => {
    artifacts = await mkdtemp(join(tmpdir(), "foxtrust-005-us2-"));
    await loadFixtureDataset(db.sql);
  }, 120_000);

  test("US2-1: the included ASNs' prefixes are ingested with code cloud; excluded ASNs contribute nothing", async () => {
    const text = await Bun.file(CLOUD_LIST).text();
    expect(cloudFeed(text).files.map((f) => f.name)).toEqual(["as8075.json", "as16509.json", "as20473.json", "as396982.json"]);
    const report = await run(text);
    expect(report.status).toBe("applied");
    const open = await openPrefixes();
    for (const asn of [16509, 396982, 8075, 20473]) expect(open).toEqual(expect.arrayContaining(await prefixesOf(asn)));
    const [row] = await db.sql<{ codes: string[] }[]>`
      SELECT array_agg(DISTINCT code) AS codes FROM category_interval WHERE source = 'ipverse-cloud'`;
    expect(row?.codes).toEqual(["cloud"]);
  });

  test("US2-2: an invalid list fails the run with the line number and leaves stored cloud data unchanged", async () => {
    const before = await intervals();
    expect(before.length).toBeGreaterThan(0);
    const cases: [string, string][] = [
      ["missing source", list(row("16509"), row("396982", "include", ""), row("8075"), row("20473"))],
      ["duplicate ASN", list(row("16509"), row("396982"), row("8075"), row("20473"), row("8075"))],
      ["malformed ASN", list(row("16509"), row("AS396982"), row("8075"), row("20473"))],
      ["included and excluded", list(row("16509"), row("396982"), row("8075"), row("20473"), row("16509", "exclude", undefined, "oops"))],
    ];
    for (const [name, text] of cases) {
      const report = await run(text);
      expect({ name, status: report.status }).toEqual({ name, status: "failed" });
      expect(report.error).toMatch(/config\/cloud\/asns\.csv line \d+: /);
      expect(await intervals()).toEqual(before);
    }
  });

  test("US2-3: an ASN removed from the list loses its cloud prefixes at the next run; the others stay", async () => {
    expect((await run(list(...GOOD_ROWS))).status).toMatch(/applied|unchanged/);
    const azure = await prefixesOf(8075);
    const report = await run(list(...GOOD_ROWS.filter((r) => !r.startsWith("8075,"))), CLOUD_FILES.filter((f) => !f.endsWith("as8075.json")));
    expect(report.status).toBe("applied");
    const open = await openPrefixes();
    const onlyAzure = azure.filter((p) => !open.includes(p));
    expect(onlyAzure.length).toBeGreaterThan(0);
    expect(open).toEqual(expect.arrayContaining(await prefixesOf(16509)));
  });
});
