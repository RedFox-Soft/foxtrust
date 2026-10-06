import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { toIpValue, type IpValue } from "../../src/ip/parse";
import { issueChallenge } from "../../src/verify/challenge/challenge";
import { waitUrl } from "../../src/verify/challenge/page";
import { createTestPublication, type TestPublication } from "../helpers/publication";
import {
  ADDR, CHALLENGE_PATH, CHALLENGE_SECRET, getChallengePage, getWait, publishRecordedSnapshot, startTestVerify, type TestVerify,
} from "../helpers/verify";

const tor = ADDR.tor[4];

describe("US4 (spec 006): operators can let visitors without JavaScript pass", () => {
  let pub: TestPublication;
  let offsetMs = 0;
  const clock = () => new Date(Date.now() + offsetMs);
  const started: TestVerify[] = [];
  const start = async (noJs: boolean) => {
    const v = await startTestVerify({
      pub, challengeUrl: CHALLENGE_PATH, challengeSecret: CHALLENGE_SECRET, clock, challenge: { noJs, waitSeconds: 3 },
    });
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

  test("US4-1: by default the page says JavaScript is needed and no pass can be earned without it", async () => {
    const v = await start(false);
    const page = await getChallengePage(v, { client: tor, returnTo: "/login" });
    expect(page.html).toContain("JavaScript is needed to continue");
    expect(page.waitChallenge).toBeNull();
    const handMade = issueChallenge({
      kind: "wait", ip: toIpValue(tor) as IpValue, bits: 0, ttlSeconds: 120, waitSeconds: 0, secret: CHALLENGE_SECRET, now: new Date(),
    });
    const answer = await getWait(v, { client: tor, url: waitUrl(CHALLENGE_PATH, handMade, "/login") });
    expect(answer.cookie).toBeNull();
  });

  test("US4-2: with the waiting path on, waiting out the refresh returns the visitor with a pass", async () => {
    const v = await start(true);
    const page = await getChallengePage(v, { client: tor, returnTo: "/login" });
    expect(page.waitSeconds).toBe(3);
    expect(page.waitUrl).toStartWith(`${CHALLENGE_PATH}/wait?c=`);
    expect(page.waitUrl).toEndWith(`&r=${encodeURIComponent("/login")}`);
    offsetMs = 3000;
    try {
      const answer = await getWait(v, { client: tor, url: page.waitUrl! });
      expect({ status: answer.status, location: answer.location, pass: answer.pass !== null }).toEqual({ status: 303, location: "/login", pass: true });
      expect(v.logs).toContain(`challenge: pass ${tor} kind=wait`);
    } finally {
      offsetMs = 0;
    }
  });

  test("US4-3: refreshing before the wait is over earns no pass and shows the remaining wait", async () => {
    const v = await start(true);
    const page = await getChallengePage(v, { client: tor, returnTo: "/login" });
    offsetMs = 1000;
    try {
      const answer = await getWait(v, { client: tor, url: page.waitUrl! });
      expect({ status: answer.status, cookie: answer.cookie }).toEqual({ status: 200, cookie: null });
      expect(answer.html).toContain("Please wait 2 more seconds");
      expect(answer.html).toContain('http-equiv="refresh" content="2;url=');
    } finally {
      offsetMs = 0;
    }
  });

  test("US4-4: a waiting-path answer is refused once the operator turned the path off", async () => {
    const on = await start(true);
    const page = await getChallengePage(on, { client: tor, returnTo: "/login" });
    const off = await start(false);
    offsetMs = 3000;
    try {
      const answer = await getWait(off, { client: tor, url: page.waitUrl! });
      expect(answer.cookie).toBeNull();
      expect(off.logs).toContain(`challenge: refused ${tor} reason=nojs-off`);
    } finally {
      offsetMs = 0;
    }
  });
});
