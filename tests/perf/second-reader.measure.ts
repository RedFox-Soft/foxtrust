import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Reader } from "mmdb-lib";
import { formatIp } from "../../src/ip/parse";
import { buildFull } from "../../src/snapshot/build";
import { deserializeRanges } from "../../src/snapshot/ranges";
import { dataLabel, loadStage2Data, sampleAddresses } from "./stage2-data";
import { prng, tempDb, type Measurement } from "./util";

const SAMPLE = 10_000;

const PYTHON = `
import json, sys, maxminddb
reader = maxminddb.open_database("/data/snapshot.mmdb")
with open("/data/addresses.txt") as f, open("/data/python.jsonl", "w") as out:
    for line in f:
        out.write(json.dumps(reader.get(line.strip())) + "\\n")
`;

/**
 * SC-001: a published snapshot answers the same in two unrelated MMDB readers: mmdb-lib
 * (JavaScript) and MaxMind's own maxminddb (Python, run in docker python:3-slim), for 10,000
 * IPv4 and IPv6 addresses.
 */
export async function measureSecondReader(): Promise<Measurement[]> {
  const db = await tempDb("bench_reader");
  const dir = await mkdtemp(join(tmpdir(), "foxtrust-reader-"));
  try {
    await loadStage2Data(db.sql, join(dir, "artifacts"));
    const build = await buildFull(db.sql, { at: new Date(), disputeUrl: "https://foxtrust.example/dispute" });
    const addresses = sampleAddresses(deserializeRanges(build.rangeTable), SAMPLE, prng(1)).map(formatIp);
    await Bun.write(join(dir, "snapshot.mmdb"), build.bytes);
    await Bun.write(join(dir, "addresses.txt"), `${addresses.join("\n")}\n`);
    await Bun.write(join(dir, "read.py"), PYTHON);

    const docker = Bun.spawn(
      ["docker", "run", "--rm", "-v", `${dir.replaceAll("\\", "/")}:/data`, "python:3-slim", "sh", "-c",
        "pip install --quiet --disable-pip-version-check --root-user-action=ignore maxminddb && python /data/read.py"],
      { stdout: "inherit", stderr: "inherit" },
    );
    if ((await docker.exited) !== 0) throw new Error("docker python:3-slim with maxminddb failed");

    const python = (await Bun.file(join(dir, "python.jsonl")).text()).split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const js = new Reader(Buffer.from(build.bytes));
    let agree = 0;
    let withRecord = 0;
    const mismatches: string[] = [];
    addresses.forEach((ip, i) => {
      const a = js.get(ip) ?? null;
      const b = python[i] ?? null;
      if (a !== null) withRecord++;
      if (Bun.deepEquals(a, b)) agree++;
      else if (mismatches.length < 3) mismatches.push(`${ip}: ${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`);
    });
    for (const m of mismatches) console.error(`  mismatch ${m}`);
    return [
      {
        criterion: `002 SC-001 mmdb-lib vs Python maxminddb (${dataLabel()})`,
        target: "100 %",
        measured: `${((agree / addresses.length) * 100).toFixed(2)} % of ${addresses.length} (${withRecord} with a record)`,
        pass: agree === addresses.length && python.length === addresses.length,
      },
    ];
  } finally {
    await rm(dir, { recursive: true, force: true });
    await db.drop();
  }
}

if (import.meta.main) console.table(await measureSecondReader());
