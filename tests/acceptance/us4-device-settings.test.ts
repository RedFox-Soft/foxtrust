import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestPublication, type TestPublication } from "../helpers/publication";
import {
  ADDR, answerWithSample, CHALLENGE_PATH, CHALLENGE_SECRET, EXAMPLE_POLICY, getChallengePage, loadSample, publishRecordedSnapshot, startTestVerify,
  type TestVerify,
} from "../helpers/verify";

const ROOT = join(import.meta.dir, "..", "..");
const HOST = { "X-Forwarded-Host": "app.example" };
const costOf = (challenge: string) => (JSON.parse(Buffer.from(challenge.split(".")[0]!, "base64url").toString("utf8")) as { d: number }).d;

describe("US4 (spec 008): the operator controls the device token", () => {
  let pub: TestPublication;
  const started: TestVerify[] = [];
  const start = async (opts: Parameters<typeof startTestVerify>[0]) => {
    const v = await startTestVerify(opts);
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

  test("US4-1: turned off, no device cookie is set and a presented token is ignored", async () => {
    const base = { pub, challengeUrl: CHALLENGE_PATH, challengeSecret: CHALLENGE_SECRET, bot: { mode: "enforce" as const } };
    const on = await start({ ...base, device: {} });
    const off = await start({ ...base, device: { enabled: false } });
    const sample = await loadSample("chrome-desktop");
    const token = (await answerWithSample(on, sample, { headers: HOST })).device!;
    const answer = await answerWithSample(off, sample, { headers: HOST });
    expect({ pass: answer.pass !== null, device: answer.device }).toEqual({ pass: true, device: null });
    const page = await getChallengePage(off, { client: ADDR.tor[4], headers: { ...HOST, Cookie: `foxtrust_device=${token}` } });
    expect(costOf(page.challenge!)).toBeGreaterThan(0);
  });

  test("US4-2: /status shows the settings and the numbers of tracked and revoked tokens", async () => {
    const v = await start({ pub, challengeUrl: CHALLENGE_PATH, challengeSecret: CHALLENGE_SECRET, bot: { mode: "enforce" }, device: { ttlDays: 7, cap: 5 } });
    const token = (await answerWithSample(v, await loadSample("chrome-desktop"))).device!;
    await answerWithSample(v, await loadSample("playwright-chromium-headless"), { client: ADDR.tor[4], headers: { Cookie: `foxtrust_device=${token}` } });
    const status = (await (await fetch(`${v.url}/status`)).json()) as { device: unknown };
    expect(status.device).toEqual({ enabled: true, ttlDays: 7, cap: 5, tracked: 1, revoked: 1 });
  });

  test("US4-3: verify serve refuses an invalid device setting or state file and names it", async () => {
    const bad = join(tmpdir(), `foxtrust-device-bad-${crypto.randomUUID()}.json`);
    await Bun.write(bad, "{");
    for (const [env, named] of [
      [{ FOXTRUST_DEVICE_CAP: "0" }, "FOXTRUST_DEVICE_CAP"],
      [{ FOXTRUST_DEVICE_STATE: bad }, "FOXTRUST_DEVICE_STATE"],
    ] as const) {
      const proc = Bun.spawn(["bun", "run", "src/cli/main.ts", "verify", "serve"], {
        cwd: ROOT,
        env: {
          PATH: Bun.env.PATH ?? "", SYSTEMROOT: Bun.env.SYSTEMROOT ?? "",
          FOXTRUST_PUBLICATION_URL: pub.url, FOXTRUST_TRUSTED_KEYS: pub.publicKey, FOXTRUST_POLICY_FILE: EXAMPLE_POLICY,
          FOXTRUST_CHALLENGE_URL: CHALLENGE_PATH, FOXTRUST_CHALLENGE_SECRET: CHALLENGE_SECRET, PORT: "0", ...env,
        },
        stdout: "pipe", stderr: "pipe",
      });
      const timer = setTimeout(() => proc.kill(), 20_000);
      const code = await proc.exited;
      clearTimeout(timer);
      const stderr = await new Response(proc.stderr).text();
      expect({ env, code, named: stderr.includes(named) }).toEqual({ env, code: 2, named: true });
    }
  });
});
