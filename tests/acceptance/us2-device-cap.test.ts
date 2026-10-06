import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createTestPublication, type TestPublication } from "../helpers/publication";
import {
  ADDR, answerWithSample, CHALLENGE_PATH, CHALLENGE_SECRET, getChallengePage, loadSample, publishRecordedSnapshot, startTestVerify, type TestVerify,
} from "../helpers/verify";

const costOf = (challenge: string) => (JSON.parse(Buffer.from(challenge.split(".")[0]!, "base64url").toString("utf8")) as { d: number }).d;

describe("US2 (spec 008): a token cannot farm passes for many addresses", () => {
  let pub: TestPublication;
  const started: TestVerify[] = [];
  let offsetMs = 0;
  const start = async (cap: number) => {
    const v = await startTestVerify({
      pub, challengeUrl: CHALLENGE_PATH, challengeSecret: CHALLENGE_SECRET, bot: { mode: "enforce" }, device: { cap },
      clock: () => new Date(Date.now() + offsetMs),
    });
    started.push(v);
    return v;
  };
  const withDevice = (token: string) => ({ Cookie: `foxtrust_device=${token}` });

  beforeAll(async () => {
    pub = await createTestPublication();
    await publishRecordedSnapshot(pub);
  });

  afterAll(async () => {
    for (const v of started) await v.stop();
    await pub?.stop();
  });

  test("US2-1: beyond the cap of distinct addresses in 24 hours, the normal challenge applies", async () => {
    const v = await start(2);
    const sample = await loadSample("chrome-desktop");
    const first = await answerWithSample(v, sample, { client: ADDR.residential[4] });
    const token = first.device!;
    const second = await answerWithSample(v, sample, { client: ADDR.low[4], headers: withDevice(token) });
    expect(second.pass).not.toBeNull();
    const before = v.logs.length;
    const third = await getChallengePage(v, { client: ADDR.cloud[4], headers: withDevice(token) });
    expect(costOf(third.challenge!)).toBeGreaterThan(0);
    expect(v.logs.slice(before)).toContain(`challenge: device-cap ${ADDR.cloud[4]}`);
    offsetMs = 25 * 3_600_000;
    try {
      const later = await getChallengePage(v, { client: ADDR.cloud[4], headers: withDevice(token) });
      expect(costOf(later.challenge!)).toBe(0);
    } finally {
      offsetMs = 0;
    }
  });

  test("US2-2: addresses of one IPv6 /64 count as one", async () => {
    const v = await start(1);
    const sample = await loadSample("chrome-desktop");
    const first = await answerWithSample(v, sample, { client: "2001:db8:5::10" });
    const page = await getChallengePage(v, { client: "2001:db8:5::11", headers: withDevice(first.device!) });
    expect(costOf(page.challenge!)).toBe(0);
  });

  test("US2-3: a good token does not help an automated browser", async () => {
    const v = await start(20);
    const first = await answerWithSample(v, await loadSample("chrome-desktop"));
    const bot = await answerWithSample(v, await loadSample("playwright-chromium-headless"), { client: ADDR.tor[4], headers: withDevice(first.device!) });
    expect({ status: bot.status, pass: bot.pass }).toEqual({ status: 403, pass: null });
  });
});
