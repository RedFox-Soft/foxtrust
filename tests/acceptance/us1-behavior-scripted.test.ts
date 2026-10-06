import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createTestPublication, type TestPublication } from "../helpers/publication";
import {
  answerWithSample, CHALLENGE_PATH, CHALLENGE_SECRET, loadSample, publishRecordedSnapshot, startTestVerify, type BotSample, type TestVerify,
} from "../helpers/verify";

/**
 * The scripted hold samples were recorded in headless browsers, which the environment checks of spec 007
 * already catch. Each scenario sends their input from a clean desktop Chrome sample instead: a stealth
 * browser driving the same input, so the behavior codes are the only evidence.
 */
describe("US1 (spec 009): evasive automation fails the hold step", () => {
  let pub: TestPublication;
  let v: TestVerify;
  let clean: BotSample;

  beforeAll(async () => {
    pub = await createTestPublication();
    await publishRecordedSnapshot(pub);
    v = await startTestVerify({ pub, challengeUrl: CHALLENGE_PATH, challengeSecret: CHALLENGE_SECRET, bot: { mode: "enforce", hold: true } });
    clean = await loadSample("chrome-desktop");
  });

  afterAll(async () => {
    await v?.stop();
    await pub?.stop();
  });

  const outcome = (status: number, cookie: string | null) => (cookie ? "pass" : status === 403 ? "block" : status === 200 ? "stepup" : `status ${status}`);

  /** Answers with the clean browser and the scripted sample's hold input; returns the outcome and the log line. */
  async function holdAs(label: string, index: number, behavior: Record<string, unknown> = {}) {
    const scripted = await loadSample(label, index);
    const before = v.logs.length;
    const answer = await answerWithSample(v, clean, { behavior: { ...scripted.behavior, ...behavior } });
    const line = v.logs.slice(before).find((l) => l.startsWith("challenge: "))!;
    return { index, outcome: outcome(answer.status, answer.cookie), line, scripted };
  }

  test("US1-1: a straight scripted pointer path gets no pass, and the log names behavior.straight", async () => {
    for (const index of [0, 1, 2, 3, 4]) {
      const { outcome, line } = await holdAs("hold-playwright-straight", index);
      expect({ index, outcome }).not.toEqual({ index, outcome: "pass" });
      expect(line).toContain("behavior.straight:+");
    }
  });

  test("US1-2: a generated Bézier path (ghost-cursor, also behind puppeteer-stealth) gets no pass", async () => {
    for (const label of ["hold-ghost-cursor", "hold-stealth-ghost"]) {
      for (const index of [0, 1, 2, 3, 4]) {
        const { outcome } = await holdAs(label, index);
        expect({ label, index, outcome }).not.toEqual({ label, index, outcome: "pass" });
      }
    }
  });

  test("US1-3: direct protocol events get no pass, and untrusted events are named", async () => {
    for (const index of [0, 1, 2, 3, 4]) {
      const { outcome, line } = await holdAs("hold-cdp-direct", index);
      expect({ index, outcome }).not.toEqual({ index, outcome: "pass" });
      expect(line).toMatch(/behavior\.(teleport|exact_center):\+/);
    }
    const { outcome, line } = await holdAs("hold-cdp-direct", 0, { untrusted: 3 });
    expect(outcome).toBe("block");
    expect(line).toContain("behavior.untrusted:+5.0");
  });

  test("US1-4: the log line lists the behavior codes with weights and no coordinate or timing from the input", async () => {
    const { line, scripted } = await holdAs("hold-ghost-cursor", 0);
    expect(line).toMatch(/^challenge: (stepup|block) \S+ kind=pow bits=\d+ bot=\d\.\d\d mode=enforce reasons=\S+$/);
    expect(line).toContain("behavior.press_in_motion:+2.0");
    expect(line).toContain("behavior.exact_hold:+2.5");
    const b = scripted.behavior as { ptr: [number, number, number][]; press: [number, number, number]; release: number };
    for (const [t, x, y] of [...b.ptr, b.press]) {
      expect(line).not.toContain(`${x},${y}`);
      expect(line).not.toMatch(new RegExp(`[^\\d.]${t}[^\\d.]`));
    }
    expect(line).not.toContain(String(b.release));
  });
});
