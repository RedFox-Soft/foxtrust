import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createTestPublication, type TestPublication } from "../helpers/publication";
import {
  ADDR, answerWithSample, CHALLENGE_PATH, CHALLENGE_SECRET, loadSample, publishRecordedSnapshot, startTestVerify, type TestVerify,
} from "../helpers/verify";

describe("US1 (spec 007): obvious automation does not get a pass", () => {
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

  const outcome = (status: number, cookie: string | null) => (cookie ? "pass" : status === 403 ? "block" : status === 200 ? "stepup" : `status ${status}`);

  test("US1-1: a correct answer from stock headless Playwright (Chromium) gets no pass", async () => {
    for (const index of [0, 1]) {
      const answer = await answerWithSample(v, await loadSample("playwright-chromium-headless", index));
      expect({ index, outcome: outcome(answer.status, answer.cookie) }).toEqual({ index, outcome: "block" });
    }
  });

  test("US1-2: a correct answer from stock headless Puppeteer gets no pass", async () => {
    for (const index of [0, 1]) {
      const answer = await answerWithSample(v, await loadSample("puppeteer-headless", index));
      expect({ index, outcome: outcome(answer.status, answer.cookie) }).toEqual({ index, outcome: "block" });
    }
  });

  test("US1-3: the log line names the address, action, score and reasons, and nothing else about the client", async () => {
    const sample = await loadSample("playwright-chromium-headless");
    const before = v.logs.length;
    await answerWithSample(v, sample);
    const line = v.logs.slice(before).find((l) => l.startsWith("challenge: "))!;
    expect(line).toMatch(new RegExp(`^challenge: block ${ADDR.residential[4].replaceAll(".", "\\.")} kind=pow bits=\\d+ bot=\\d\\.\\d\\d mode=enforce reasons=\\S+$`));
    expect(line).toContain("env.webdriver:+5.0");
    expect(line).toContain("env.headless_ua:+5.0");
    expect(line).not.toContain(sample.probe.ua);
    expect(line).not.toContain(sample.probe.tz);
  });

  test("US1-4: a correct answer without a valid probe counts as automation, never as a clean browser", async () => {
    // Clean request headers (a stealth browser) from a medium-risk address, so the probe is the only evidence.
    const sample = await loadSample("puppeteer-stealth");
    for (const probe of [null, "{"] as const) {
      const before = v.logs.length;
      const answer = await answerWithSample(v, sample, { client: ADDR.tor[4], probe });
      const line = v.logs.slice(before).find((l) => l.startsWith("challenge: "))!;
      expect({ probe, outcome: outcome(answer.status, answer.cookie) }).toEqual({ probe, outcome: "stepup" });
      expect(line).toContain("env.probe_missing:+3.0");
    }
  });
});
