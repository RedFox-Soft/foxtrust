import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readChallenge } from "../../src/verify/challenge/challenge";
import { createTestPublication, type TestPublication } from "../helpers/publication";
import {
  ADDR, CHALLENGE_PATH, CHALLENGE_SECRET, forwardAuth, getChallengePage, passChallenge, postAnswer, publishRecordedSnapshot,
  solveChallenge, startTestVerify, wrongSolution, type TestVerify,
} from "../helpers/verify";

/** Re-encodes a challenge's payload with changes, keeping the original MAC. */
function tamper(challenge: string, change: Record<string, unknown>): string {
  const [payload, mac] = challenge.split(".") as [string, string];
  const body = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
  return `${Buffer.from(JSON.stringify({ ...body, ...change })).toString("base64url")}.${mac}`;
}

describe("US2 (spec 006): passes cannot be forged, replayed or used to redirect elsewhere", () => {
  let pub: TestPublication;
  let v: TestVerify;
  let offsetMs = 0;

  beforeAll(async () => {
    pub = await createTestPublication();
    await publishRecordedSnapshot(pub);
    v = await startTestVerify({
      pub, challengeUrl: CHALLENGE_PATH, challengeSecret: CHALLENGE_SECRET, clock: () => new Date(Date.now() + offsetMs),
    });
  });

  afterAll(async () => {
    await v?.stop();
    await pub?.stop();
  });

  const tor = ADDR.tor[4];

  test("US2-1: an answer that already earned a pass earns nothing the second time", async () => {
    const page = await getChallengePage(v, { client: tor, returnTo: "/login" });
    const s = solveChallenge(page.challenge!);
    const first = await postAnswer(v, { client: tor, c: page.challenge!, s, r: "/login" });
    expect(first.pass).not.toBeNull();
    const second = await postAnswer(v, { client: tor, c: page.challenge!, s, r: "/login" });
    expect({ status: second.status, cookie: second.cookie }).toEqual({ status: 200, cookie: null });
    expect(second.html).toContain('name="c" value="');
    expect(second.html).not.toContain(page.challenge!);
  });

  test("US2-2: an answer posted from another address earns no pass", async () => {
    const page = await getChallengePage(v, { client: tor, returnTo: "/login" });
    const answer = await postAnswer(v, { client: ADDR.low[4], c: page.challenge!, s: solveChallenge(page.challenge!), r: "/login" });
    expect({ status: answer.status, cookie: answer.cookie }).toEqual({ status: 200, cookie: null });
  });

  test("US2-3: a challenge with a changed difficulty, address or expiry earns no pass", async () => {
    const page = await getChallengePage(v, { client: tor, returnTo: "/login" });
    const original = readChallenge(page.challenge!)!;
    for (const change of [{ d: 1 }, { a: ADDR.low[4] }, { exp: original.exp + 3600 }]) {
      const forged = tamper(page.challenge!, change);
      const answer = await postAnswer(v, { client: tor, c: forged, s: solveChallenge(forged), r: "/login" });
      expect({ change, cookie: answer.cookie }).toEqual({ change, cookie: null });
    }
  });

  test("US2-4: a wrong solution or an expired challenge earns no pass and gets a fresh challenge", async () => {
    const page = await getChallengePage(v, { client: tor, returnTo: "/login" });
    const wrong = await postAnswer(v, { client: tor, c: page.challenge!, s: wrongSolution(page.challenge!), r: "/login" });
    expect({ status: wrong.status, cookie: wrong.cookie }).toEqual({ status: 200, cookie: null });

    const late = await getChallengePage(v, { client: tor, returnTo: "/login" });
    offsetMs = 121_000;
    try {
      const expired = await postAnswer(v, { client: tor, c: late.challenge!, s: solveChallenge(late.challenge!), r: "/login" });
      expect({ status: expired.status, cookie: expired.cookie }).toEqual({ status: 200, cookie: null });
      const fresh = /name="c" value="([^"]+)"/.exec(expired.html)?.[1];
      expect(fresh).toBeDefined();
      expect(Buffer.from(readChallenge(fresh!)!.nonce)).not.toEqual(Buffer.from(readChallenge(late.challenge!)!.nonce));
    } finally {
      offsetMs = 0;
    }
  });

  test("US2-5: a return address off the protected host leads to its root", async () => {
    const host = { "X-Forwarded-Host": "app.example" };
    const cases: [string, string][] = [
      ["https://evil.example/x", "/"],
      ["//evil.example", "/"],
      ["/\\evil.example", "/"],
      ["javascript:alert(1)", "/"],
      ["http://other.example/", "/"],
      ["https://app.example/a?b=1", "/a?b=1"],
    ];
    for (const [returnTo, expected] of cases) {
      const page = await getChallengePage(v, { client: tor, returnTo, headers: host });
      const answer = await postAnswer(v, { client: tor, c: page.challenge!, s: solveChallenge(page.challenge!), r: returnTo, headers: host });
      expect({ returnTo, status: answer.status, location: answer.location }).toEqual({ returnTo, status: 303, location: expected });
    }
  });

  test("US2-6: a pass is ignored when presented from another address", async () => {
    const { pass } = await passChallenge(v, { client: tor, returnTo: "/login" });
    // Another Tor exit in the same IPv4 range: a different /32, so the pass does not cover it.
    const r = await forwardAuth(v, { client: "198.51.100.8", uri: "/login", headers: { Cookie: `foxtrust_pass=${pass!}` } });
    expect({ action: r.action, reason: r.reason }).toEqual({ action: "challenge", reason: "rule" });
  });
});
