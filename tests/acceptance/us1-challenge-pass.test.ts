import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createTestPublication, type TestPublication } from "../helpers/publication";
import {
  ADDR, CHALLENGE_PATH, CHALLENGE_SECRET, forwardAuth, passChallenge, PROXY_MODES, publishRecordedSnapshot, startTestVerify, type TestVerify,
} from "../helpers/verify";

describe("US1 (spec 006): a visitor passes without solving anything", () => {
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

  const withPass = (pass: string) => ({ Cookie: `foxtrust_pass=${pass}` });

  test("US1-1: a challenged request is sent to the page on the same host with the original path as the return address", async () => {
    const page = `${CHALLENGE_PATH}?return=${encodeURIComponent("/login?x=1")}`;
    const forwarded = { "X-Forwarded-Host": "app.example:8443", "X-Forwarded-Proto": "https" };
    for (const mode of PROXY_MODES) {
      // With the forwarded host the location is absolute on it; without, relative to the request.
      for (const [headers, expected] of [[forwarded, `https://app.example:8443${page}`], [{}, page]] as const) {
        const r = await forwardAuth(v, { mode, client: ADDR.tor[4], uri: "/login?x=1", headers });
        expect({ mode, action: r.action, rule: r.rule }).toEqual({ mode, action: "challenge", rule: "tor-on-login" });
        if (mode === "nginx") {
          expect(r.status).toBe(401);
          expect(r.challengeLocation).toBe(expected);
        } else {
          expect(r.status).toBe(302);
          expect(r.location).toBe(expected);
        }
      }
    }
  });

  test("US1-2: a correct answer sets the pass cookie, returns the visitor, and /verify then allows", async () => {
    const answer = await passChallenge(v, { client: ADDR.tor[4], returnTo: "/login?x=1" });
    expect(answer.status).toBe(303);
    expect(answer.location).toBe("/login?x=1");
    const attributes = answer.cookie!.split(";").map((part) => part.trim());
    expect(attributes).toEqual(expect.arrayContaining(["Path=/", "Max-Age=1800", "HttpOnly", "SameSite=Lax", "Secure"]));
    expect(attributes.some((part) => part.startsWith("Domain="))).toBe(false);

    const r = await forwardAuth(v, { client: ADDR.tor[4], uri: "/login?x=1", headers: withPass(answer.pass!) });
    expect({ status: r.status, action: r.action, reason: r.reason }).toEqual({ status: 200, action: "allow", reason: "challenge-pass" });
  });

  test("US1-3: a valid pass lets other challenged paths through without a new challenge", async () => {
    const { pass } = await passChallenge(v, { client: ADDR.tor[4], returnTo: "/login" });
    const r = await forwardAuth(v, { client: ADDR.tor[4], uri: "/login/other", headers: withPass(pass!) });
    expect({ action: r.action, reason: r.reason }).toEqual({ action: "allow", reason: "challenge-pass" });
  });

  test("US1-4: an expired pass is challenged again", async () => {
    const { pass } = await passChallenge(v, { client: ADDR.tor[4], returnTo: "/login" });
    offsetMs = 31 * 60 * 1000;
    try {
      const r = await forwardAuth(v, { client: ADDR.tor[4], uri: "/login", headers: withPass(pass!) });
      expect({ action: r.action, reason: r.reason }).toEqual({ action: "challenge", reason: "rule" });
    } finally {
      offsetMs = 0;
    }
  });

  test("US1-5: an IPv6 pass covers its /64 and nothing outside it", async () => {
    const { pass } = await passChallenge(v, { client: ADDR.tor[6], returnTo: "/login" });
    const sameNet = await forwardAuth(v, { client: "2001:db8:1::8", uri: "/login", headers: withPass(pass!) });
    expect({ action: sameNet.action, reason: sameNet.reason }).toEqual({ action: "allow", reason: "challenge-pass" });
    // Another /64 inside the same Tor /48: the policy still challenges it.
    const otherNet = await forwardAuth(v, { client: "2001:db8:1:1::7", uri: "/login", headers: withPass(pass!) });
    expect({ action: otherNet.action, reason: otherNet.reason }).toEqual({ action: "challenge", reason: "rule" });
  });
});
