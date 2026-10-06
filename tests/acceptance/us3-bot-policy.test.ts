import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { createTestPublication, type TestPublication } from "../helpers/publication";
import {
  answerWithSample, CHALLENGE_PATH, CHALLENGE_SECRET, EXAMPLE_POLICY, loadSample, publishRecordedSnapshot, startTestVerify, type TestVerify,
} from "../helpers/verify";

const ROOT = join(import.meta.dir, "..", "..");
/** Priors −1; webdriver, headless UA (probe and request) +2 each: stealth ≈ 0.27, Playwright Firefox ≈ 0.73, Playwright Chromium ≈ 0.99. */
const WEIGHTS = join(import.meta.dir, "..", "fixtures", "bot", "weights-test.json");
const outcome = (status: number, cookie: string | null) => (cookie ? "pass" : status === 403 ? "block" : status === 200 ? "stepup" : `status ${status}`);

async function serve(extra: Record<string, string>) {
  const proc = Bun.spawn(["bun", "run", "src/cli/main.ts", "verify", "serve"], {
    cwd: ROOT,
    env: {
      PATH: Bun.env.PATH ?? "", SYSTEMROOT: Bun.env.SYSTEMROOT ?? "",
      FOXTRUST_PUBLICATION_URL: "http://127.0.0.1:1",
      FOXTRUST_TRUSTED_KEYS: "MCowBQYDK2VwAyEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
      FOXTRUST_POLICY_FILE: EXAMPLE_POLICY,
      FOXTRUST_CHALLENGE_URL: CHALLENGE_PATH,
      FOXTRUST_CHALLENGE_SECRET: CHALLENGE_SECRET,
      PORT: "0",
      ...extra,
    },
    stdout: "pipe", stderr: "pipe",
  });
  const timer = setTimeout(() => proc.kill(), 20_000);
  const code = await proc.exited;
  clearTimeout(timer);
  return { code, stderr: await new Response(proc.stderr).text() };
}

describe("US3 (spec 007): the operator decides what each score leads to", () => {
  let pub: TestPublication;
  const started: TestVerify[] = [];
  const start = async (bot: Parameters<typeof startTestVerify>[0]["bot"]) => {
    const v = await startTestVerify({ pub, challengeUrl: CHALLENGE_PATH, challengeSecret: CHALLENGE_SECRET, bot: { weightsFile: WEIGHTS, ...bot } });
    started.push(v);
    return v;
  };

  beforeAll(async () => {
    pub = await createTestPublication();
    await publishRecordedSnapshot(pub);
  });

  afterAll(async () => {
    for (const v of started) await v.stop();
    await pub?.stop();
  });

  test("US3-1: scores below, between and above the thresholds give pass, step-up and block", async () => {
    const v = await start({ stepUp: 0.5, block: 0.9 });
    const results: Record<string, string> = {};
    for (const label of ["puppeteer-stealth", "playwright-firefox-headless", "playwright-chromium-headless"]) {
      const answer = await answerWithSample(v, await loadSample(label));
      results[label] = outcome(answer.status, answer.cookie);
    }
    expect(results).toEqual({ "puppeteer-stealth": "pass", "playwright-firefox-headless": "stepup", "playwright-chromium-headless": "block" });
  });

  test("US3-2: after one step-up the policy's action applies, a block score still blocks, and there is no second step-up", async () => {
    const firefox = await loadSample("playwright-firefox-headless");
    const chromium = await loadSample("playwright-chromium-headless");
    for (const [afterStepUp, expected] of [["pass", "pass"], ["block", "block"]] as const) {
      const v = await start({ afterStepUp });
      const first = await answerWithSample(v, firefox);
      expect(outcome(first.status, first.cookie)).toBe("stepup");
      const second = await answerWithSample(v, firefox, { challenge: first.stepUpChallenge! });
      expect({ afterStepUp, outcome: outcome(second.status, second.cookie) }).toEqual({ afterStepUp, outcome: expected });
      // A score at or above the block threshold blocks after a step-up too.
      const stepped = await answerWithSample(v, firefox);
      const blocked = await answerWithSample(v, chromium, { challenge: stepped.stepUpChallenge! });
      expect({ afterStepUp, outcome: outcome(blocked.status, blocked.cookie) }).toEqual({ afterStepUp, outcome: "block" });
    }
  });

  test("US3-3: verify serve refuses thresholds out of order or outside 0–1 and names the setting", async () => {
    for (const [env, named] of [
      [{ FOXTRUST_BOT_STEPUP: "0.95", FOXTRUST_BOT_BLOCK: "0.9" }, "FOXTRUST_BOT_STEPUP"],
      [{ FOXTRUST_BOT_BLOCK: "1.5" }, "FOXTRUST_BOT_BLOCK"],
    ] as const) {
      const { code, stderr } = await serve(env);
      expect({ env, code, named: stderr.includes(named) }).toEqual({ env, code: 2, named: true });
    }
  });

  test("US3-4: the block page says access was refused, links the dispute page and shows no reasons", async () => {
    const v = await start({});
    const answer = await answerWithSample(v, await loadSample("playwright-chromium-headless"));
    expect(answer.status).toBe(403);
    expect(answer.html).toContain("Access was refused");
    expect(answer.html).toContain('href="https://foxtrust.example/dispute"');
    expect(answer.html).not.toMatch(/env\.|req\.|transport\.|bot=/);
  });
});
