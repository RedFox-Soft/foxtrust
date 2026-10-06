import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { issueDeviceToken } from "../../src/verify/device/token";
import { createTestPublication, type TestPublication } from "../helpers/publication";
import {
  ADDR, answerWithSample, CHALLENGE_PATH, CHALLENGE_SECRET, forwardAuth, getChallengePage, loadSample, publishRecordedSnapshot, startTestVerify,
  type TestVerify,
} from "../helpers/verify";

/** The payload of a challenge string (d, r), without checking it. */
const payloadOf = (challenge: string) => JSON.parse(Buffer.from(challenge.split(".")[0]!, "base64url").toString("utf8")) as { d: number; r?: string };

describe("US1 (spec 008): a returning visitor is not slowed down after an address change", () => {
  let pub: TestPublication;
  let v: TestVerify;
  let offsetMs = 0;

  beforeAll(async () => {
    pub = await createTestPublication();
    await publishRecordedSnapshot(pub);
    v = await startTestVerify({
      pub, challengeUrl: CHALLENGE_PATH, challengeSecret: CHALLENGE_SECRET, bot: { mode: "enforce" }, device: {},
      clock: () => new Date(Date.now() + offsetMs),
    });
  });

  afterAll(async () => {
    await v?.stop();
    await pub?.stop();
  });

  const withDevice = (token: string) => ({ Cookie: `foxtrust_device=${token}` });

  test("US1-1: a clean pass also sets a host-only device token with its own lifetime", async () => {
    const answer = await answerWithSample(v, await loadSample("chrome-desktop"));
    expect(answer.pass).not.toBeNull();
    const attributes = answer.deviceCookie!.split(";").map((p) => p.trim());
    expect(attributes).toEqual(expect.arrayContaining(["Path=/", "Max-Age=2592000", "HttpOnly", "SameSite=Lax"]));
    expect(attributes.some((p) => p.startsWith("Domain="))).toBe(false);
  });

  test("US1-2: with the token from a new address, the page asks for no proof-of-work and the answer earns a pass", async () => {
    const sample = await loadSample("chrome-desktop");
    const first = await answerWithSample(v, sample);
    const page = await getChallengePage(v, { client: ADDR.tor[4], returnTo: "/login", headers: withDevice(first.device!) });
    const payload = payloadOf(page.challenge!);
    expect({ d: payload.d, bound: typeof payload.r === "string" }).toEqual({ d: 0, bound: true });
    const answer = await answerWithSample(v, sample, { client: ADDR.tor[4], headers: withDevice(first.device!), challenge: page.challenge! });
    expect(answer.pass).not.toBeNull();
    const r = await forwardAuth(v, { client: ADDR.tor[4], uri: "/login", headers: { Cookie: `foxtrust_pass=${answer.pass!}` } });
    expect({ action: r.action, reason: r.reason }).toEqual({ action: "allow", reason: "challenge-pass" });
  });

  test("US1-3: the log shows the returning-device reason and never the token", async () => {
    const sample = await loadSample("chrome-desktop");
    const first = await answerWithSample(v, sample);
    const before = v.logs.length;
    await answerWithSample(v, sample, { client: ADDR.tor[4], headers: withDevice(first.device!) });
    const line = v.logs.slice(before).find((l) => l.startsWith("challenge: pass"))!;
    expect(line).toContain("bits=0");
    expect(line).toContain("attest.returning_device:-1.0");
    const id = JSON.parse(Buffer.from(first.device!.split(".")[0]!, "base64url").toString("utf8")).id as string;
    for (const l of v.logs) {
      expect(l.includes(first.device!)).toBe(false);
      expect(l.includes(id)).toBe(false);
    }
  });

  test("US1-4: an expired, forged or other-host token is ignored", async () => {
    const first = await answerWithSample(v, await loadSample("chrome-desktop"));
    // Change a character in the middle of the MAC: the last base64url character carries unused bits.
    const at = first.device!.length - 10;
    const forged = `${first.device!.slice(0, at)}${first.device![at] === "A" ? "B" : "A"}${first.device!.slice(at + 1)}`;
    const otherHost = issueDeviceToken({ host: "other.example", ttlDays: 30, secret: CHALLENGE_SECRET, now: new Date() }).token;
    for (const [name, headers] of [
      ["forged", withDevice(forged)],
      ["other host", { ...withDevice(otherHost), "X-Forwarded-Host": "app.example" }],
    ] as const) {
      const page = await getChallengePage(v, { client: ADDR.tor[4], headers });
      expect({ name, d: payloadOf(page.challenge!).d > 0 }).toEqual({ name, d: true });
    }
    offsetMs = 31 * 86_400_000;
    try {
      const page = await getChallengePage(v, { client: ADDR.tor[4], headers: withDevice(first.device!) });
      expect({ name: "expired", d: payloadOf(page.challenge!).d > 0 }).toEqual({ name: "expired", d: true });
    } finally {
      offsetMs = 0;
    }
  });
});
