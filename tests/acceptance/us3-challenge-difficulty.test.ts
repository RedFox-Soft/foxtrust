import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { readChallenge } from "../../src/verify/challenge/challenge";
import { createTestPublication, type TestPublication } from "../helpers/publication";
import {
  ADDR, CHALLENGE_PATH, CHALLENGE_SECRET, getChallengePage, postAnswer, publishRecordedSnapshot, solveChallenge, startTestVerify, type TestVerify,
} from "../helpers/verify";

const CHALLENGE_ALL = join(import.meta.dir, "..", "fixtures", "policies", "challenge-all.yaml");
const DIFFICULTY = { none: 8, low: 9, medium: 10, high: 11 };

describe("US3 (spec 006): riskier addresses pay more", () => {
  let pub: TestPublication;
  const started: TestVerify[] = [];
  const start = async (opts: Parameters<typeof startTestVerify>[0]) => {
    const v = await startTestVerify({ policyFile: CHALLENGE_ALL, challengeUrl: CHALLENGE_PATH, challengeSecret: CHALLENGE_SECRET, ...opts });
    started.push(v);
    return v;
  };
  const bitsOf = async (v: TestVerify, client: string) => readChallenge((await getChallengePage(v, { client })).challenge!)!.bits;

  beforeAll(async () => {
    pub = await createTestPublication();
    await publishRecordedSnapshot(pub);
  });

  afterAll(async () => {
    for (const v of started) await v.stop();
    await pub?.stop();
  });

  test("US3-1: each challenge carries the difficulty of its address's level", async () => {
    const v = await start({ pub, challenge: { difficulty: DIFFICULTY } });
    expect({
      low: await bitsOf(v, ADDR.low[4]),
      medium: await bitsOf(v, ADDR.tor[4]),
      high: await bitsOf(v, ADDR.high[4]),
    }).toEqual({ low: 9, medium: 10, high: 11 });
  });

  test("US3-2: an address without data, or any address without a snapshot, gets the default difficulty", async () => {
    const v = await start({ pub, challenge: { difficulty: DIFFICULTY } });
    expect(await bitsOf(v, ADDR.unlisted[4])).toBe(8);
    const empty = await start({ pub: null, challenge: { difficulty: DIFFICULTY } });
    expect(await bitsOf(empty, ADDR.tor[4])).toBe(8);
  });

  test("US3-3: challenges issued under old settings stay valid; new ones use the new settings", async () => {
    const before = await start({ pub, challenge: { difficulty: DIFFICULTY } });
    const page = await getChallengePage(before, { client: ADDR.tor[4], returnTo: "/login" });
    const after = await start({ pub, challenge: { difficulty: { ...DIFFICULTY, medium: 12, high: 12 } } });
    const answer = await postAnswer(after, { client: ADDR.tor[4], c: page.challenge!, s: solveChallenge(page.challenge!), r: "/login" });
    expect({ status: answer.status, pass: answer.pass !== null }).toEqual({ status: 303, pass: true });
    expect(await bitsOf(after, ADDR.tor[4])).toBe(12);
  });
});
