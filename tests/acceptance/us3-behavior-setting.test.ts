import { afterAll, describe, expect, test } from "bun:test";
import { DEFAULT_BOT_POLICY, type BotPolicy } from "../../src/verify/bot/policy";
import { createTestPublication, type TestPublication } from "../helpers/publication";
import {
  ADDR, answerWithSample, CHALLENGE_PATH, CHALLENGE_SECRET, getChallengePage, loadSample, publishRecordedSnapshot, startTestVerify, type TestVerify,
} from "../helpers/verify";

/** A person's keyboard hold: operating-system auto-repeat and a release a reaction time after the bar fills. */
const KEYBOARD_HOLD = {
  res: 0.1, box: { w: 398, h: 56 }, kind: "key", ptr: [], press: [1800, null, null], release: 3050, moves: { count: 0, maxPx: 0 },
  keys: [[1800, "d", 0], [2310, "d", 1], [2343, "d", 1], [2376, "d", 1], [2409, "d", 1], [3050, "u", 0]], untrusted: 0, vis: [],
};

describe("US3 (spec 009): the operator decides when the hold step appears", () => {
  const running: { pub: TestPublication; v: TestVerify }[] = [];

  async function start(bot: Partial<BotPolicy>, device = false): Promise<TestVerify> {
    const pub = await createTestPublication();
    await publishRecordedSnapshot(pub);
    const v = await startTestVerify({ pub, challengeUrl: CHALLENGE_PATH, challengeSecret: CHALLENGE_SECRET, bot, ...(device ? { device: {} } : {}) });
    running.push({ pub, v });
    return v;
  }

  afterAll(async () => {
    for (const { pub, v } of running) {
      await v.stop();
      await pub.stop();
    }
  });

  test("US3-1: by default every challenged visitor gets the hold step, also with a returning-device token", async () => {
    expect(DEFAULT_BOT_POLICY.hold).toBe(true);
    const v = await start({ mode: "enforce", hold: DEFAULT_BOT_POLICY.hold }, true);
    const first = await getChallengePage(v, { client: ADDR.residential[4], returnTo: "/login" });
    expect(first.html).toContain('id="foxtrust-hold"');

    const passed = await answerWithSample(v, await loadSample("chrome-desktop"), { behavior: KEYBOARD_HOLD });
    expect(passed.device).not.toBeNull();
    const returning = await getChallengePage(v, { client: ADDR.tor[4], returnTo: "/login", headers: { Cookie: `foxtrust_device=${passed.device!}` } });
    expect(returning.html).toContain('id="foxtrust-hold"');
  });

  test("US3-2: with the step off, the page has no hold control and an answer without input is not marked", async () => {
    const v = await start({ mode: "enforce", hold: false });
    const page = await getChallengePage(v, { client: ADDR.residential[4], returnTo: "/login" });
    expect(page.html).not.toContain('id="foxtrust-hold"');
    const before = v.logs.length;
    const answer = await answerWithSample(v, await loadSample("chrome-desktop"), { behavior: null });
    expect(answer.pass).not.toBeNull();
    expect(v.logs.slice(before).join("\n")).not.toContain("behavior.");
  });

  test("US3-3: in observe mode, scripted input still passes, and the log shows what enforce would do", async () => {
    const v = await start({ mode: "observe", hold: true });
    const before = v.logs.length;
    const answer = await answerWithSample(v, await loadSample("chrome-desktop"), { behavior: (await loadSample("hold-cdp-direct")).behavior! });
    expect(answer.pass).not.toBeNull();
    const line = v.logs.slice(before).find((l) => l.startsWith("challenge: "))!;
    expect(line).toMatch(/ would=(stepup|block) /);
    expect(line).toContain("behavior.teleport:+");
  });
});
