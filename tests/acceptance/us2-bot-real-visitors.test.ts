import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createTestPublication, type TestPublication } from "../helpers/publication";
import {
  ADDR, answerWithSample, BOT_SAMPLES, CHALLENGE_PATH, CHALLENGE_SECRET, loadSample, publishRecordedSnapshot, startTestVerify, type TestVerify,
} from "../helpers/verify";

/**
 * Real-browser samples, recorded with `foxtrust bot record` from browsers started normally (no
 * automation) with throw-away profiles (spec 007 task T014). Labels without samples yet (Safari,
 * mobile, Tor Browser "Safer") are skipped, by name, rather than faked.
 */
const MAINSTREAM = ["chrome-desktop", "firefox-desktop", "edge-desktop", "opera-desktop", "safari-desktop", "chrome-android", "safari-ios"];
const TOR = ["tor-browser-standard", "tor-browser-safer"];
const present = (label: string) => existsSync(join(BOT_SAMPLES, label)) && readdirSync(join(BOT_SAMPLES, label)).some((f) => f.endsWith(".json"));
const mainstream = MAINSTREAM.filter(present);
const tor = TOR.filter(present);

describe("US2 (spec 007): real visitors are not slowed down", () => {
  let pub: TestPublication;
  let v: TestVerify;

  beforeAll(async () => {
    pub = await createTestPublication();
    await publishRecordedSnapshot(pub);
    v = await startTestVerify({ pub, challengeUrl: CHALLENGE_PATH, challengeSecret: CHALLENGE_SECRET, bot: { mode: "enforce" } });
  });

  afterAll(async () => {
    await v?.stop();
    await pub?.stop();
  });

  test.skipIf(mainstream.length === 0)("US2-1: mainstream desktop and mobile browsers pass on the first attempt", async () => {
    for (const label of mainstream) {
      for (const file of readdirSync(join(BOT_SAMPLES, label)).filter((f) => f.endsWith(".json")).keys()) {
        const answer = await answerWithSample(v, await loadSample(label, file));
        expect({ label, file, pass: answer.cookie !== null }).toEqual({ label, file, pass: true });
      }
    }
  });

  test.skipIf(tor.length === 0)("US2-2: Tor Browser passes from a Tor exit despite its uniform profile", async () => {
    for (const label of tor) {
      const before = v.logs.length;
      const answer = await answerWithSample(v, await loadSample(label), { client: ADDR.tor[4] });
      const line = v.logs.slice(before).find((l) => l.startsWith("challenge: "))!;
      expect({ label, pass: answer.cookie !== null }).toEqual({ label, pass: true });
      expect(line).toContain("profile.uniform");
    }
  });

  test.skipIf(!present("chrome-desktop"))("US2-3: a time zone of another country alone does not cause a step-up", async () => {
    // Counterfactual on a recorded sample: the same browser, travelling (zone of another country than DE).
    const answer = await answerWithSample(v, await loadSample("chrome-desktop"), { client: ADDR.residential[4], probe: { tz: "America/New_York" } });
    expect(answer.cookie).not.toBeNull();
  });
});
