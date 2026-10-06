import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestPublication, type TestPublication } from "../helpers/publication";
import {
  ADDR, answerWithSample, CHALLENGE_PATH, CHALLENGE_SECRET, getChallengePage, loadSample, publishRecordedSnapshot, startTestVerify, type TestVerify,
} from "../helpers/verify";

/** Priors −1; webdriver and headless UA +2 each: chrome ≈ 0.27, Playwright Firefox ≈ 0.73, Playwright Chromium ≈ 0.99. */
const WEIGHTS = join(import.meta.dir, "..", "fixtures", "bot", "weights-test.json");
const costOf = (challenge: string) => (JSON.parse(Buffer.from(challenge.split(".")[0]!, "base64url").toString("utf8")) as { d: number }).d;
const withDevice = (token: string) => ({ Cookie: `foxtrust_device=${token}` });

describe("US3 (spec 008): a token stops working once its browser is caught", () => {
  let pub: TestPublication;
  const started: TestVerify[] = [];
  const start = async (stateFile: string) => {
    const v = await startTestVerify({
      pub, challengeUrl: CHALLENGE_PATH, challengeSecret: CHALLENGE_SECRET, bot: { mode: "enforce", weightsFile: WEIGHTS }, device: {},
      deviceStateFile: stateFile,
    });
    started.push(v);
    return v;
  };
  const freshFile = () => join(tmpdir(), `foxtrust-device-${crypto.randomUUID()}.json`);

  beforeAll(async () => {
    pub = await createTestPublication();
    await publishRecordedSnapshot(pub);
  });

  afterAll(async () => {
    for (const v of started) await v.stop();
    await pub?.stop();
  });

  test("US3-1: a block or a failed step-up revokes the token and deletes the cookie", async () => {
    const v = await start(freshFile());
    const chrome = await loadSample("chrome-desktop");
    const blockedToken = (await answerWithSample(v, chrome)).device!;
    const blocked = await answerWithSample(v, await loadSample("playwright-chromium-headless"), { client: ADDR.tor[4], headers: withDevice(blockedToken) });
    expect({ status: blocked.status, device: blocked.device }).toEqual({ status: 403, device: "deleted" });

    const steppedToken = (await answerWithSample(v, chrome)).device!;
    const firefox = await loadSample("playwright-firefox-headless");
    const first = await answerWithSample(v, firefox, { client: ADDR.tor[4], headers: withDevice(steppedToken) });
    expect(first.stepUpChallenge).not.toBeNull();
    const second = await answerWithSample(v, firefox, { client: ADDR.tor[4], headers: withDevice(steppedToken), challenge: first.stepUpChallenge! });
    // afterStepUp is pass, so the visitor gets through, but the token is gone.
    expect({ pass: second.pass !== null, device: second.device }).toEqual({ pass: true, device: "deleted" });
  });

  test("US3-2: a revoked token is ignored from any address", async () => {
    const v = await start(freshFile());
    const token = (await answerWithSample(v, await loadSample("chrome-desktop"))).device!;
    await answerWithSample(v, await loadSample("playwright-chromium-headless"), { client: ADDR.tor[4], headers: withDevice(token) });
    const page = await getChallengePage(v, { client: ADDR.low[4], headers: withDevice(token) });
    expect(costOf(page.challenge!)).toBeGreaterThan(0);
  });

  test("US3-3: a revocation survives a restart of verify", async () => {
    const file = freshFile();
    const first = await start(file);
    const token = (await answerWithSample(first, await loadSample("chrome-desktop"))).device!;
    await answerWithSample(first, await loadSample("playwright-chromium-headless"), { client: ADDR.tor[4], headers: withDevice(token) });
    await first.stop();
    started.splice(started.indexOf(first), 1);
    const second = await start(file);
    const page = await getChallengePage(second, { client: ADDR.low[4], headers: withDevice(token) });
    expect(costOf(page.challenge!)).toBeGreaterThan(0);
  });
});
