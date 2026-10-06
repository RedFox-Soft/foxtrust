import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createTestPublication, type TestPublication } from "../helpers/publication";
import {
  answerWithSample, CHALLENGE_PATH, CHALLENGE_SECRET, loadSample, publishRecordedSnapshot, sampleHeaders, startTestVerify, type TestVerify,
} from "../helpers/verify";

describe("US4 (spec 007): the probe result cannot be forged into a clean verdict", () => {
  let pub: TestPublication;
  let v: TestVerify;

  beforeAll(async () => {
    pub = await createTestPublication();
    await publishRecordedSnapshot(pub);
    v = await startTestVerify({ pub, challengeUrl: CHALLENGE_PATH, challengeSecret: CHALLENGE_SECRET, bot: { mode: "enforce" } });
  });

  afterAll(async () => {
    await v?.stop();
    await pub?.stop();
  });

  const lastLine = (before: number) => v.logs.slice(before).find((l) => l.startsWith("challenge: "))!;

  test("US4-1: a clean probe on a request whose headers say otherwise counts against the session", async () => {
    // The stealth sample's probe is a clean Chrome; the request headers come from stock headless Puppeteer.
    const clean = await loadSample("puppeteer-stealth");
    const script = await loadSample("puppeteer-headless");
    const before = v.logs.length;
    const answer = await answerWithSample(v, clean, { headers: sampleHeaders(script) });
    const line = lastLine(before);
    expect(answer.cookie).toBeNull();
    expect(line).toContain("env.ua_mismatch");
    expect(line).toContain("req.headless_ua");
  });

  test("US4-2: a probe bound to another challenge counts as missing", async () => {
    const before = v.logs.length;
    await answerWithSample(v, await loadSample("puppeteer-stealth"), { probe: { n: "AAAAAAAAAAAAAAAAAAAAAA" } });
    expect(lastLine(before)).toContain("env.probe_missing");
  });

  test("US4-3: an oversized or deeply nested probe counts as missing and the answer is still handled", async () => {
    const sample = await loadSample("puppeteer-stealth");
    for (const probe of ["x".repeat(3000), `${'{"a":'.repeat(50)}1${"}".repeat(50)}`]) {
      const before = v.logs.length;
      const answer = await answerWithSample(v, sample, { probe });
      expect(answer.status).toBeLessThan(500);
      expect(lastLine(before)).toContain("env.probe_missing");
    }
  });
});
