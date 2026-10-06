import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestPublication, type TestPublication } from "../helpers/publication";
import {
  ADDR, answerWithSample, CHALLENGE_PATH, CHALLENGE_SECRET, forwardAuth, getChallengePage, loadSample, publishRecordedSnapshot, startTestVerify,
  type TestVerify,
} from "../helpers/verify";

const costOf = (challenge: string) => (JSON.parse(Buffer.from(challenge.split(".")[0]!, "base64url").toString("utf8")) as { d: number }).d;

describe("SEC (spec 008): returning-device token inputs", () => {
  let pub: TestPublication;
  let v: TestVerify;
  const stateFile = join(tmpdir(), `foxtrust-device-sec-${crypto.randomUUID()}.json`);

  beforeAll(async () => {
    pub = await createTestPublication();
    await publishRecordedSnapshot(pub);
    v = await startTestVerify({
      pub, challengeUrl: CHALLENGE_PATH, challengeSecret: CHALLENGE_SECRET, bot: { mode: "enforce" }, device: {}, deviceStateFile: stateFile,
    });
  });

  afterAll(async () => {
    await v?.stop();
    await pub?.stop();
  });

  test("SEC: a device token is never a pass, and a pass is never a device token", async () => {
    const answer = await answerWithSample(v, await loadSample("chrome-desktop"));
    const asPass = await forwardAuth(v, { client: ADDR.tor[4], uri: "/login", headers: { Cookie: `foxtrust_pass=${answer.device!}` } });
    expect({ action: asPass.action, reason: asPass.reason }).toEqual({ action: "challenge", reason: "rule" });
    const page = await getChallengePage(v, { client: ADDR.tor[4], headers: { Cookie: `foxtrust_device=${answer.pass!}` } });
    expect(costOf(page.challenge!)).toBeGreaterThan(0);
  });

  test("SEC: a challenge is never a device token", async () => {
    const challenge = (await getChallengePage(v, { client: ADDR.residential[4] })).challenge!;
    const page = await getChallengePage(v, { client: ADDR.tor[4], headers: { Cookie: `foxtrust_device=${challenge}` } });
    expect(costOf(page.challenge!)).toBeGreaterThan(0);
  });

  test("SEC: a zero-cost challenge answered without its device token is refused", async () => {
    const sample = await loadSample("chrome-desktop");
    const token = (await answerWithSample(v, sample)).device!;
    const page = await getChallengePage(v, { client: ADDR.tor[4], headers: { Cookie: `foxtrust_device=${token}` } });
    expect(costOf(page.challenge!)).toBe(0);
    const before = v.logs.length;
    const answer = await answerWithSample(v, sample, { client: ADDR.tor[4], challenge: page.challenge! });
    expect(answer.pass).toBeNull();
    expect(v.logs.slice(before)).toContain(`challenge: refused ${ADDR.tor[4]} reason=device bits=0`);
  });

  test("SEC: the state file holds no address, prefix or user agent", async () => {
    const sample = await loadSample("chrome-desktop");
    const token = (await answerWithSample(v, sample, { client: ADDR.residential[4] })).device!;
    for (const client of [ADDR.tor[4], ADDR.residential[6]]) {
      await answerWithSample(v, sample, { client, headers: { Cookie: `foxtrust_device=${token}` } });
    }
    await v.stop();
    const text = await Bun.file(stateFile).text();
    expect(text.length).toBeGreaterThan(10);
    for (const secret of [ADDR.residential[4], ADDR.tor[4], ADDR.residential[6], "198.19.0.10/32", "2001:db8:5::/64", "2001:db8:5:", sample.headers["user-agent"]!]) {
      expect({ secret, found: text.includes(secret) }).toEqual({ secret, found: false });
    }
    v = await startTestVerify({ pub, challengeUrl: CHALLENGE_PATH, challengeSecret: CHALLENGE_SECRET, device: {}, deviceStateFile: stateFile });
  });
});
