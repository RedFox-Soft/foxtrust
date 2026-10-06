import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { toIpValue, type IpValue } from "../../src/ip/parse";
import { issuePassTokenV2 } from "../../src/verify/token";
import { createTestPublication, type TestPublication } from "../helpers/publication";
import {
  ADDR, CHALLENGE_PATH, CHALLENGE_SECRET, forwardAuth, getChallengePage, passChallenge, postAnswer, publishRecordedSnapshot,
  solveChallenge, startTestVerify, type TestVerify,
} from "../helpers/verify";

const ip = (text: string) => toIpValue(text) as IpValue;
const tor = ADDR.tor[4];

describe("SEC: built-in challenge page inputs", () => {
  let pub: TestPublication;
  let v: TestVerify;

  beforeAll(async () => {
    pub = await createTestPublication();
    await publishRecordedSnapshot(pub);
    v = await startTestVerify({ pub, challengeUrl: CHALLENGE_PATH, challengeSecret: CHALLENGE_SECRET });
  });

  afterAll(async () => {
    await v?.stop();
    await pub?.stop();
  });

  test("SEC: a challenge string presented as a pass is ignored", async () => {
    const { challenge } = await getChallengePage(v, { client: tor });
    const r = await forwardAuth(v, { client: tor, uri: "/login", headers: { Cookie: `foxtrust_pass=${challenge!}` } });
    expect({ action: r.action, reason: r.reason }).toEqual({ action: "challenge", reason: "rule" });
  });

  test("SEC: a pass token posted as a challenge is refused", async () => {
    const pass = issuePassTokenV2(ip(tor), 1800, CHALLENGE_SECRET);
    const answer = await postAnswer(v, { client: tor, c: pass, s: "1", r: "/login" });
    expect(answer.cookie).toBeNull();
    expect(v.logs).toContain(`challenge: refused ${tor} reason=signature`);
  });

  test("SEC: challenge route variants are not exempt from the policy", async () => {
    for (const uri of [
      `${CHALLENGE_PATH}/../login`,
      `${CHALLENGE_PATH}%2F..%2Flogin`,
      `${CHALLENGE_PATH}X`,
      `${CHALLENGE_PATH}/other`,
      `/login?x=${CHALLENGE_PATH}`,
    ]) {
      const r = await forwardAuth(v, { client: tor, uri, headers: {} });
      expect({ uri, reason: r.reason }).not.toEqual({ uri, reason: "challenge-page" });
    }
    // Paths the policy challenges stay challenged when dressed up as the page.
    const dressed = await forwardAuth(v, { client: tor, uri: `/login/..${CHALLENGE_PATH}` });
    expect({ action: dressed.action, reason: dressed.reason }).toEqual({ action: "challenge", reason: "rule" });
  });

  test("SEC: an oversized answer body or field is refused before hashing", async () => {
    const big = await postAnswer(v, { client: tor, c: "", s: "", body: `c=${"a".repeat(5000)}` });
    expect({ status: big.status, cookie: big.cookie }).toEqual({ status: 400, cookie: null });
    const longChallenge = await postAnswer(v, { client: tor, c: `${"a".repeat(599)}.`, s: "1" });
    expect({ status: longChallenge.status, cookie: longChallenge.cookie }).toEqual({ status: 400, cookie: null });
    const longCounter = await postAnswer(v, { client: tor, c: "a.b", s: "1".repeat(25) });
    expect(longCounter.status).toBe(400);
  });

  test("SEC: CR/LF and control characters in the return address never reach Location", async () => {
    for (const returnTo of ["/a\r\nSet-Cookie: x=1", "/a\u0000b", "/a b", "/\tevil"]) {
      const page = await getChallengePage(v, { client: tor, returnTo });
      expect(page.returnTo).toBe("/");
      const answer = await postAnswer(v, { client: tor, c: page.challenge!, s: solveChallenge(page.challenge!), r: returnTo });
      expect({ returnTo, location: answer.location }).toEqual({ returnTo, location: "/" });
    }
  });

  test("SEC: the page sends CSP, nosniff, no-referrer and no-store, and loads only its own scripts", async () => {
    const page = await getChallengePage(v, { client: tor, returnTo: "/login" });
    const csp = page.headers.get("content-security-policy") ?? "";
    for (const directive of ["default-src 'none'", "script-src 'self'", "worker-src 'self'", "form-action 'self'", "frame-ancestors 'none'", "base-uri 'none'"]) {
      expect(csp).toContain(directive);
    }
    expect(page.headers.get("x-content-type-options")).toBe("nosniff");
    expect(page.headers.get("referrer-policy")).toBe("no-referrer");
    expect(page.headers.get("cache-control")).toBe("no-store");
    const sources = [...page.html.matchAll(/\b(?:src|href|action)="([^"]*)"/g)].map((m) => m[1]!);
    expect(sources.every((src) => src.startsWith(CHALLENGE_PATH) || src === "/")).toBe(true);
    for (const name of ["page.js", "worker.js"]) {
      const res = await fetch(`${v.url}${CHALLENGE_PATH}/${name}`);
      await res.arrayBuffer();
      expect({ name, type: res.headers.get("content-type"), cache: res.headers.get("cache-control") }).toEqual({
        name, type: "text/javascript; charset=utf-8", cache: "no-store",
      });
    }
  });

  test("SEC: filling the replay cache from one address does not lock out other addresses", async () => {
    const small = await startTestVerify({ pub, challengeUrl: CHALLENGE_PATH, challengeSecret: CHALLENGE_SECRET, replayCap: 2 });
    try {
      const answers = [];
      for (let i = 0; i < 3; i++) {
        const page = await getChallengePage(small, { client: tor });
        const s = solveChallenge(page.challenge!);
        const answer = await postAnswer(small, { client: tor, c: page.challenge!, s });
        expect(answer.pass).not.toBeNull();
        answers.push({ c: page.challenge!, s });
      }
      const other = await passChallenge(small, { client: ADDR.low[4] });
      expect(other.pass).not.toBeNull();
      const replay = await postAnswer(small, { client: tor, ...answers[2]! });
      expect(replay.cookie).toBeNull();
      expect(small.logs.at(-1)).toBe(`challenge: refused ${tor} reason=replay bits=8`);
    } finally {
      await small.stop();
    }
  });
});
