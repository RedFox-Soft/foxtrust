import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { evaluateSamples, readSamples } from "../../src/bot/eval";
import { DEFAULT_BOT_POLICY } from "../../src/verify/bot/policy";
import { activeWeightsFile } from "../../src/verify/bot/weights";
import { BOT_SAMPLES } from "../helpers/verify";

const ROOT = join(import.meta.dir, "..", "..");
const PREVIOUS_WEIGHTS = join(ROOT, "config", "bot", "2026-10-06.2.json");

describe("US4 (spec 009): behavior weights are measured before they ship", () => {
  const holdLabels = [...new Set(readSamples(BOT_SAMPLES).filter((s) => s.behavior !== undefined).map((s) => s.label))];

  test("US4-1: the evaluation lists every hold label with its counts and its behavior-only passes", async () => {
    expect(holdLabels.length).toBeGreaterThan(0);
    const { result } = await evaluateSamples({ samplesDir: BOT_SAMPLES, weightsFile: activeWeightsFile({}), policy: DEFAULT_BOT_POLICY });
    const samples = readSamples(BOT_SAMPLES);
    for (const label of holdLabels) {
      const row = result.labels.find((l) => l.label === label)!;
      const n = samples.filter((s) => s.label === label).length;
      expect({ label, total: row.pass + row.stepup + row.block, measured: row.behaviorPass !== null }).toEqual({ label, total: n, measured: true });
    }
    expect(result.hold.sc001).not.toBeNull();
    expect(result.hold.sc003).not.toBeNull();
  });

  test("US4-2: comparing with the weights before behavior evidence shows both versions for the hold labels", async () => {
    const proc = Bun.spawn(["bun", "run", "src/cli/main.ts", "bot", "eval", "--compare", PREVIOUS_WEIGHTS, "--json"], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
    const out = JSON.parse(await new Response(proc.stdout).text()) as {
      result: { weightsVersion: string; labels: { label: string; behaviorPass: number | null }[] };
      compare: { weightsVersion: string; labels: { label: string; behaviorPass: number | null }[] };
    };
    expect(await proc.exited).toBe(0);
    expect(out.compare.weightsVersion).toBe("2026-10-06.2");
    expect(out.result.weightsVersion).not.toBe(out.compare.weightsVersion);
    for (const label of holdLabels) {
      for (const side of [out.result, out.compare]) {
        expect({ label, version: side.weightsVersion, listed: side.labels.some((l) => l.label === label && l.behaviorPass !== null) })
          .toEqual({ label, version: side.weightsVersion, listed: true });
      }
    }
  });
});
