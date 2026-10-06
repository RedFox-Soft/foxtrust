import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { createTestPublication, type TestPublication } from "../helpers/publication";
import {
  answerWithSample, BOT_SAMPLES, CHALLENGE_PATH, CHALLENGE_SECRET, loadSample, publishRecordedSnapshot, startTestVerify, type BotSample, type TestVerify,
} from "../helpers/verify";

type Hold = { res: number; ptr: [number, number, number][]; press: [number, number | null, number | null]; release: number };

/** A person's keyboard hold, clean on its own. */
const KEYBOARD_HOLD = {
  res: 0.1, box: { w: 398, h: 56 }, kind: "key", ptr: [], press: [1800, null, null], release: 3050, moves: { count: 0, maxPx: 0 },
  keys: [[1800, "d", 0], [2310, "d", 1], [2343, "d", 1], [3050, "u", 0]], untrusted: 0, vis: [],
};

/** A number in a log line, not as part of a longer number or an address. */
const standalone = (value: number) => new RegExp(`(?<![\\d.])${String(value).replace(".", "\\.")}(?![\\d.])`);

describe("SEC (spec 009): behavior inputs", () => {
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

  const lineAfter = (before: number) => v.logs.slice(before).find((l) => l.startsWith("challenge: "))!;

  test("SEC: behavior values never reach the log", async () => {
    const before = v.logs.length;
    const holds: Hold[] = [];
    for (const label of readdirSync(BOT_SAMPLES).filter((l) => l.startsWith("hold-"))) {
      const files = readdirSync(join(BOT_SAMPLES, label)).filter((f) => f.endsWith(".json"));
      for (let index = 0; index < files.length; index++) {
        const sample = await loadSample(label, index);
        await answerWithSample(v, sample);
        await answerWithSample(v, clean, { behavior: sample.behavior! });
        holds.push(sample.behavior as unknown as Hold);
      }
    }
    const lines = v.logs.slice(before);
    expect(lines.length).toBeGreaterThan(0);
    for (const hold of holds) {
      for (const [, x, y] of hold.ptr) {
        expect({ pair: `${x},${y}`, leaked: lines.some((l) => l.includes(`${x},${y}`)) }).toEqual({ pair: `${x},${y}`, leaked: false });
      }
      for (const value of [hold.press[0], hold.release, hold.res]) {
        expect({ value, leaked: lines.some((l) => standalone(value).test(l)) }).toEqual({ value, leaked: false });
      }
    }
  });

  test("SEC: an oversized, malformed or foreign behavior payload counts as missing", async () => {
    const foreign = JSON.stringify({ ...KEYBOARD_HOLD, n: "AAAAAAAAAAAAAAAAAAAAAA" });
    // Bound to the right challenge (the helper sets n), but over the size limit.
    const oversized = { ...KEYBOARD_HOLD, ptr: Array.from({ length: 199 }, (_, i) => [100_000 + i * 997, -9000 - i, -8000 - i]) };
    for (const [name, behavior] of [["foreign", foreign], ["oversized", oversized], ["malformed", "{"], ["absent", null]] as const) {
      const before = v.logs.length;
      const answer = await answerWithSample(v, clean, { behavior });
      expect({ name, pass: answer.pass !== null, missing: lineAfter(before).includes("behavior.missing:+3.0") }).toEqual({ name, pass: false, missing: true });
    }
  });

  test("SEC: untrusted events count even with a clean probe and a clean hold", async () => {
    let before = v.logs.length;
    const passed = await answerWithSample(v, clean, { behavior: KEYBOARD_HOLD });
    expect(passed.pass).not.toBeNull();
    expect(lineAfter(before)).not.toContain("behavior.");

    before = v.logs.length;
    const answer = await answerWithSample(v, clean, { behavior: { ...KEYBOARD_HOLD, untrusted: 1 } });
    expect(answer.pass).toBeNull();
    expect(lineAfter(before)).toContain("behavior.untrusted:+5.0");
  });
});
