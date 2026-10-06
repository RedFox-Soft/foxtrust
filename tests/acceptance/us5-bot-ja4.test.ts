import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { createTestPublication, type TestPublication } from "../helpers/publication";
import {
  answerWithSample, CHALLENGE_PATH, CHALLENGE_SECRET, loadSample, publishRecordedSnapshot, startTestVerify, type TestVerify,
} from "../helpers/verify";

/** One chromium, one gecko and one curl row (test fixture). */
const FAMILIES = join(import.meta.dir, "..", "fixtures", "bot", "ja4-families-test.csv");
const CURL_JA4 = "t13d3112h2_e8f1e7e78f70_0123456789ab";
const GECKO_JA4 = "t13d1717h2_5b57614c22b0_0123456789ab";

describe("US5 (spec 007): a proxy-supplied JA4 adds transport evidence", () => {
  let pub: TestPublication;
  const started: TestVerify[] = [];
  const start = async (opts: { trusted?: boolean; families?: boolean } = {}) => {
    const v = await startTestVerify({
      pub, challengeUrl: CHALLENGE_PATH, challengeSecret: CHALLENGE_SECRET,
      ...(opts.trusted === false ? { trustedProxies: [] } : {}),
      bot: { mode: "enforce", ...(opts.families === false ? {} : { ja4FamiliesFile: FAMILIES }) },
    });
    started.push(v);
    return v;
  };
  const lineOf = async (v: TestVerify, headers: Record<string, string>) => {
    const before = v.logs.length;
    await answerWithSample(v, await loadSample("puppeteer-stealth"), { headers });
    return v.logs.slice(before).find((l) => l.startsWith("challenge: "))!;
  };

  beforeAll(async () => {
    pub = await createTestPublication();
    await publishRecordedSnapshot(pub);
  });

  afterAll(async () => {
    for (const v of started) await v.stop();
    await pub?.stop();
  });

  test("US5-1: a JA4 from a trusted proxy that is a tool, or another browser family, adds a transport code", async () => {
    const v = await start();
    // The sample claims Chrome (chromium).
    expect(await lineOf(v, { "x-ja4": CURL_JA4 })).toContain("transport.ja4_tool");
    expect(await lineOf(v, { "x-ja4": GECKO_JA4 })).toContain("transport.ja4_mismatch");
  });

  test("US5-2: the same header from an untrusted peer is ignored", async () => {
    const v = await start({ trusted: false });
    expect(await lineOf(v, { "x-ja4": CURL_JA4 })).not.toContain("transport.");
  });

  test("US5-3: without a JA4 header the verdict uses the other layers only, with no penalty", async () => {
    const withList = await start();
    const withoutList = await start({ families: false });
    const a = await lineOf(withList, {});
    const b = await lineOf(withoutList, {});
    expect(a).not.toContain("transport.");
    expect(/bot=(\S+)/.exec(a)?.[1]).toBe(/bot=(\S+)/.exec(b)?.[1] ?? "missing");
  });
});
