import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { evaluateSamples, readSamples } from "../../src/bot/eval";
import { DEFAULT_BOT_POLICY } from "../../src/verify/bot/policy";
import { activeWeightsFile } from "../../src/verify/bot/weights";
import { createTestPublication, type TestPublication } from "../helpers/publication";
import {
  answerWithSample, BOT_SAMPLES, CHALLENGE_PATH, CHALLENGE_SECRET, EXAMPLE_POLICY, loadSample, publishRecordedSnapshot, startTestVerify,
  type TestVerify,
} from "../helpers/verify";

const ROOT = join(import.meta.dir, "..", "..");
const TEST_WEIGHTS = join(import.meta.dir, "..", "fixtures", "bot", "weights-test.json");

describe("US6 (spec 007): weights are measured before they ship", () => {
  let pub: TestPublication;
  const started: TestVerify[] = [];

  beforeAll(async () => {
    pub = await createTestPublication();
    await publishRecordedSnapshot(pub);
  });

  afterAll(async () => {
    for (const v of started) await v.stop();
    await pub?.stop();
  });

  test("US6-1: the evaluation lists outcomes per label and the false-positive rate for real browsers", async () => {
    const { result } = await evaluateSamples({ samplesDir: BOT_SAMPLES, weightsFile: activeWeightsFile({}), policy: DEFAULT_BOT_POLICY });
    const samples = readSamples(BOT_SAMPLES);
    for (const label of new Set(samples.map((s) => s.label))) {
      const row = result.labels.find((l) => l.label === label)!;
      expect({ label, total: row.pass + row.stepup + row.block }).toEqual({ label, total: samples.filter((s) => s.label === label).length });
    }
    const humans = samples.filter((s) => s.kind === "human").length;
    if (humans === 0) expect(result.humanFalsePositiveRate).toBeNull();
    else expect(result.humanFalsePositiveRate).toBeGreaterThanOrEqual(0);
  });

  test("US6-2: comparing two weights versions shows both and the change per label", async () => {
    const proc = Bun.spawn(["bun", "run", "src/cli/main.ts", "bot", "eval", "--compare", TEST_WEIGHTS, "--json"], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
    const out = JSON.parse(await new Response(proc.stdout).text()) as {
      result: { weightsVersion: string; labels: { label: string; pass: number }[] };
      compare: { weightsVersion: string; labels: { label: string; pass: number }[] };
    };
    expect(await proc.exited).toBe(0);
    expect(out.result.weightsVersion).not.toBe(out.compare.weightsVersion);
    expect(out.compare.weightsVersion).toBe("2026-01-01.1");
    expect(out.compare.labels.map((l) => l.label)).toEqual(out.result.labels.map((l) => l.label));
  });

  test("US6-3: observe mode passes automation but logs the score, the reasons and what enforcement would do", async () => {
    const v = await startTestVerify({ pub, challengeUrl: CHALLENGE_PATH, challengeSecret: CHALLENGE_SECRET, bot: { mode: "observe" } });
    started.push(v);
    const before = v.logs.length;
    const answer = await answerWithSample(v, await loadSample("playwright-chromium-headless"));
    expect(answer.cookie).not.toBeNull();
    const line = v.logs.slice(before).find((l) => l.startsWith("challenge: "))!;
    expect(line).toMatch(/^challenge: pass \S+ kind=pow bits=\d+ bot=\d\.\d\d mode=observe would=(block|stepup) reasons=.*env\.webdriver/);
  });

  test("US6-4: without bot settings the verdict runs in observe mode, and verify serve says so", async () => {
    const proc = Bun.spawn(["bun", "run", "src/cli/main.ts", "verify", "serve"], {
      cwd: ROOT,
      env: {
        PATH: Bun.env.PATH ?? "", SYSTEMROOT: Bun.env.SYSTEMROOT ?? "",
        FOXTRUST_PUBLICATION_URL: pub.url,
        FOXTRUST_TRUSTED_KEYS: pub.publicKey,
        FOXTRUST_POLICY_FILE: EXAMPLE_POLICY,
        FOXTRUST_CHALLENGE_URL: CHALLENGE_PATH,
        FOXTRUST_CHALLENGE_SECRET: CHALLENGE_SECRET,
        PORT: "0",
      },
      stdout: "pipe", stderr: "pipe",
    });
    try {
      const reader = proc.stdout.getReader();
      let out = "";
      while (!out.includes("Bot verdict:")) {
        const { value, done } = await reader.read();
        if (done) break;
        out += new TextDecoder().decode(value);
      }
      expect(out).toContain("Bot verdict: observe");
      const port = /port (\d+)/.exec(out)![1];
      const status = (await (await fetch(`http://127.0.0.1:${port}/status`)).json()) as { bot: { mode: string; weightsVersion: string } };
      expect(status.bot.mode).toBe("observe");
      expect(status.bot.weightsVersion).toMatch(/^\d{4}-\d{2}-\d{2}\.\d+$/);
    } finally {
      proc.kill();
      await proc.exited;
    }
  });
});
