import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createTestPublication, type TestPublication } from "../helpers/publication";
import {
  ADDR, answerWithSample, BOT_SAMPLES, CHALLENGE_PATH, CHALLENGE_SECRET, getChallengePage, loadSample, publishRecordedSnapshot, startTestVerify,
  type TestVerify,
} from "../helpers/verify";

const POINTER_LABELS = ["hold-mouse", "hold-touchpad", "hold-touch-phone"];
const recorded = (label: string) => existsSync(join(BOT_SAMPLES, label));
const count = (label: string) => readdirSync(join(BOT_SAMPLES, label)).filter((f) => f.endsWith(".json")).length;

describe("US2 (spec 009): people complete the hold step quickly, whatever their input", () => {
  let pub: TestPublication;
  let v: TestVerify;
  let offsetMs = 0;

  beforeAll(async () => {
    pub = await createTestPublication();
    await publishRecordedSnapshot(pub);
    v = await startTestVerify({
      pub, challengeUrl: CHALLENGE_PATH, challengeSecret: CHALLENGE_SECRET, bot: { mode: "enforce", hold: true },
      clock: () => new Date(Date.now() + offsetMs),
    });
  });

  afterAll(async () => {
    await v?.stop();
    await pub?.stop();
  });

  // The owner records these on their own devices (tasks T014); the scenario covers those recorded so far.
  test.skipIf(!POINTER_LABELS.some(recorded))("US2-1: every recorded human mouse, touchpad and touch hold passes", async () => {
    for (const label of POINTER_LABELS.filter(recorded)) {
      for (let index = 0; index < count(label); index++) {
        const answer = await answerWithSample(v, await loadSample(label, index));
        expect({ label, index, pass: answer.pass !== null }).toEqual({ label, index, pass: true });
      }
    }
  });

  test.skipIf(!recorded("hold-keyboard"))("US2-2: every keyboard hold passes, and a scripted key hold is named", async () => {
    for (let index = 0; index < count("hold-keyboard"); index++) {
      const answer = await answerWithSample(v, await loadSample("hold-keyboard", index));
      expect({ index, pass: answer.pass !== null }).toEqual({ index, pass: true });
    }
    const script = await loadSample("hold-key-script");
    const before = v.logs.length;
    await answerWithSample(v, await loadSample("chrome-desktop"), { behavior: script.behavior! });
    expect(v.logs.slice(before).find((l) => l.startsWith("challenge: "))).toContain("behavior.no_key_repeat:+");
  });

  test("US2-3: the hold control has an accessible name, instructions and announced progress, without inline styles", async () => {
    const { html } = await getChallengePage(v, { client: ADDR.residential[4], returnTo: "/login" });
    const button = /<button type="button" id="foxtrust-hold" aria-describedby="([^"]+)"[^>]*>([^<]+)<\/button>/.exec(html);
    expect(button?.[2]).toBe("Press and hold");
    expect(html).toContain(`<p id="${button![1]}"`);
    expect(html).toMatch(/<p id="foxtrust-status" role="status" aria-live="polite">[^<]*hold[^<]*<\/p>/);
    expect(html).toMatch(/<progress id="foxtrust-hold-progress" max="1000"[^>]*aria-label="[^"]+"/);
    expect(html).not.toContain(" style=");
  });

  test("US2-4: a hold answered after the challenge expired gets a fresh page, not an error", async () => {
    const sample = await loadSample("chrome-desktop");
    const { challenge } = await getChallengePage(v, { client: ADDR.residential[4], returnTo: "/login" });
    offsetMs = 10 * 60_000;
    try {
      const before = v.logs.length;
      const answer = await answerWithSample(v, sample, { challenge: challenge!, behavior: (await loadSample("hold-ghost-cursor")).behavior! });
      expect(answer.status).toBe(200);
      expect(answer.pass).toBeNull();
      expect(answer.html).toContain('id="foxtrust-hold"');
      expect(/name="c" value="([^"]+)"/.exec(answer.html)?.[1]).not.toBe(challenge);
      expect(v.logs.slice(before)).toContainEqual(expect.stringMatching(/^challenge: refused \S+ reason=expired/));
    } finally {
      offsetMs = 0;
    }
  });
});
