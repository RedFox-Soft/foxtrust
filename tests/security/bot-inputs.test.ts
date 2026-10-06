import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { createTestPublication, type TestPublication } from "../helpers/publication";
import {
  ADDR, answerWithSample, BOT_SAMPLES, CHALLENGE_PATH, CHALLENGE_SECRET, getChallengePage, loadSample, postAnswer, publishRecordedSnapshot,
  solveChallenge, startTestVerify, type TestVerify,
} from "../helpers/verify";

const FAMILIES = join(import.meta.dir, "..", "fixtures", "bot", "ja4-families-test.csv");
const CURL_JA4 = "t13d3112h2_e8f1e7e78f70_aaaaaaaaaaaa";

describe("SEC (spec 007): bot verdict inputs", () => {
  let pub: TestPublication;
  let v: TestVerify;

  beforeAll(async () => {
    pub = await createTestPublication();
    await publishRecordedSnapshot(pub);
    v = await startTestVerify({
      pub, challengeUrl: CHALLENGE_PATH, challengeSecret: CHALLENGE_SECRET, bot: { mode: "enforce", ja4FamiliesFile: FAMILIES },
    });
  });

  afterAll(async () => {
    await v?.stop();
    await pub?.stop();
  });

  test("SEC: probe values never reach the log", async () => {
    const before = v.logs.length;
    const secrets: string[] = [];
    for (const label of readdirSync(BOT_SAMPLES)) {
      for (const index of [0, 1]) {
        const sample = await loadSample(label, index).catch(() => null);
        if (!sample) continue;
        await answerWithSample(v, sample);
        const { ua, tz, langs, screen } = sample.probe;
        secrets.push(ua, tz, ...langs.filter((l) => l.length >= 5), `${screen.sw}x${screen.sh}`, `${screen.iw}x${screen.ih}`);
        if (sample.headers["x-ja4"]) secrets.push(sample.headers["x-ja4"]);
      }
    }
    const lines = v.logs.slice(before);
    expect(lines.length).toBeGreaterThan(0);
    for (const secret of secrets.filter(Boolean)) {
      expect({ secret, leaked: lines.some((line) => line.includes(secret)) }).toEqual({ secret, leaked: false });
    }
  });

  test("SEC: a step-up flag cannot be added by the client", async () => {
    const page = await getChallengePage(v, { client: ADDR.residential[4] });
    const [payload, mac] = page.challenge!.split(".") as [string, string];
    const body = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
    const forged = `${Buffer.from(JSON.stringify({ ...body, u: 1 })).toString("base64url")}.${mac}`;
    const answer = await postAnswer(v, { client: ADDR.residential[4], c: forged, s: solveChallenge(forged) });
    expect(answer.cookie).toBeNull();
    expect(v.logs.at(-1)).toBe(`challenge: refused ${ADDR.residential[4]} reason=signature`);
  });

  test("SEC: X-JA4 from an untrusted peer is ignored", async () => {
    const untrusted = await startTestVerify({
      pub, challengeUrl: CHALLENGE_PATH, challengeSecret: CHALLENGE_SECRET, trustedProxies: [], bot: { mode: "enforce", ja4FamiliesFile: FAMILIES },
    });
    try {
      const before = untrusted.logs.length;
      await answerWithSample(untrusted, await loadSample("puppeteer-stealth"), { headers: { "x-ja4": CURL_JA4 } });
      const line = untrusted.logs.slice(before).find((l) => l.startsWith("challenge: "))!;
      expect(line).not.toContain("transport.");
    } finally {
      await untrusted.stop();
    }
  });

  test("SEC: no JA4+ header is read", async () => {
    const before = v.logs.length;
    await answerWithSample(v, await loadSample("puppeteer-stealth"), {
      headers: { "x-ja4h": CURL_JA4, "x-ja4t": CURL_JA4, "x-ja4s": CURL_JA4, "x-ja4one": CURL_JA4 },
    });
    const line = v.logs.slice(before).find((l) => l.startsWith("challenge: "))!;
    expect(line).not.toContain("transport.");
  });

  test("SEC: the answer body limit is 8 KB", async () => {
    const answer = await postAnswer(v, { client: ADDR.residential[4], c: "", s: "", body: `p=${"a".repeat(9000)}` });
    expect({ status: answer.status, cookie: answer.cookie }).toEqual({ status: 400, cookie: null });
  });
});
