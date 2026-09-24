import { join } from "node:path";
import { BITS, formatCidr, parseCidr } from "../../src/ip/cidr";
import type { Signal } from "../../src/model/types";
import { score } from "../../src/scoring/score";
import { shippedConfig } from "../helpers/seed";
import { prng, type Measurement } from "./util";

const CLOUD = join(import.meta.dir, "..", "fixtures", "cloud");
const SAMPLE = 10_000;

/**
 * SC-003: no address with only category signals reaches `high`. Samples 10,000 addresses from
 * AWS and GCP ranges (fixed seed) and gives each one every category code at once.
 */
export async function measureCategoryCap(): Promise<Measurement[]> {
  const config = await shippedConfig();
  const prefixes: string[] = [];
  for (const file of ["aws-prefixes.txt", "gcp-prefixes.txt"]) {
    const text = await Bun.file(join(CLOUD, file)).text();
    prefixes.push(...text.split(/\r?\n/).filter((l) => l && !l.startsWith("#")));
  }
  const categoryCodes = Object.entries(config.codes).filter(([, d]) => d.kind === "category").map(([c]) => c);
  const random = prng(7);
  const at = new Date("2026-09-24T12:00:00Z");
  let high = 0;
  let maxRisk = 0;
  for (let i = 0; i < SAMPLE; i++) {
    const cidr = parseCidr(prefixes[Math.floor(random() * prefixes.length)]!)!;
    const hostBits = BITS[cidr.family] - cidr.length;
    const offset = hostBits === 0 ? 0n : BigInt(Math.floor(random() * Number(2n ** BigInt(Math.min(hostBits, 52)))));
    const host = formatCidr({ family: cidr.family, network: cidr.network + offset, length: BITS[cidr.family] });
    const signals: Signal[] = categoryCodes.map((code, n) => ({
      kind: "category", code, source: `measure-${n}`, prefix: host, prefixLength: BITS[cidr.family],
      firstSeen: at, lastSeen: at, confidence: 1, shippable: true,
    }));
    const result = score(signals, config, at, at);
    if (result.level === "high") high++;
    maxRisk = Math.max(maxRisk, result.risk);
  }
  return [
    {
      criterion: `SC-003 category-only never high (${SAMPLE} AWS/GCP addresses, all ${categoryCodes.length} category codes)`,
      target: "0 high",
      measured: `${high} high (max risk ${maxRisk})`,
      pass: high === 0,
    },
  ];
}

if (import.meta.main) console.table(await measureCategoryCap());
