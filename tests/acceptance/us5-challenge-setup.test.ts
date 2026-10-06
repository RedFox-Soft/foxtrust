import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { createTestPublication, type TestPublication } from "../helpers/publication";
import {
  ADDR, CHALLENGE_PATH, CHALLENGE_SECRET, EXAMPLE_POLICY, forwardAuth, getChallengePage, passChallenge, postAnswer, PROXY_MODES,
  publishRecordedSnapshot, startTestVerify, wrongSolution, type TestVerify,
} from "../helpers/verify";

const ROOT = join(import.meta.dir, "..", "..");
const tor = ADDR.tor[4];

/** `foxtrust verify serve` with a minimal environment plus `extra`; returns the exit code and stderr. */
async function serve(extra: Record<string, string>) {
  const proc = Bun.spawn(["bun", "run", "src/cli/main.ts", "verify", "serve"], {
    cwd: ROOT,
    env: {
      PATH: Bun.env.PATH ?? "",
      SYSTEMROOT: Bun.env.SYSTEMROOT ?? "",
      FOXTRUST_PUBLICATION_URL: "http://127.0.0.1:1",
      FOXTRUST_TRUSTED_KEYS: "MCowBQYDK2VwAyEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
      FOXTRUST_POLICY_FILE: EXAMPLE_POLICY,
      PORT: "0",
      ...extra,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => proc.kill(), 20_000);
  const code = await proc.exited;
  clearTimeout(timer);
  return { code, stderr: await new Response(proc.stderr).text() };
}

describe("US5 (spec 006): the operator sets it up with the proxy they already run", () => {
  let pub: TestPublication;
  let v: TestVerify;

  beforeAll(async () => {
    pub = await createTestPublication();
    await publishRecordedSnapshot(pub);
    v = await startTestVerify({ pub, challengeUrl: CHALLENGE_PATH, challengeSecret: CHALLENGE_SECRET });
  });

  afterAll(async () => {
    await v?.stop();
    await pub?.stop();
  });

  test("US5-1: verify serve refuses an incomplete or invalid challenge configuration and names the setting", async () => {
    const cases: [Record<string, string>, string][] = [
      [{ FOXTRUST_CHALLENGE_URL: CHALLENGE_PATH }, "FOXTRUST_CHALLENGE_SECRET"],
      [{ FOXTRUST_CHALLENGE_URL: CHALLENGE_PATH, FOXTRUST_CHALLENGE_SECRET: CHALLENGE_SECRET, FOXTRUST_CHALLENGE_DIFFICULTY: "low=18,medium=16" }, "FOXTRUST_CHALLENGE_DIFFICULTY"],
      [{ FOXTRUST_CHALLENGE_URL: "/verify", FOXTRUST_CHALLENGE_SECRET: CHALLENGE_SECRET }, "FOXTRUST_CHALLENGE_URL"],
    ];
    for (const [env, named] of cases) {
      const { code, stderr } = await serve(env);
      expect({ env, code, named: stderr.includes(named) }).toEqual({ env, code: 2, named: true });
    }
  });

  test("US5-2: /status shows that challenges are enforced and the settings in use", async () => {
    const status = (await (await fetch(`${v.url}/status`)).json()) as { challenge: unknown };
    expect(status.challenge).toEqual({
      enforced: true, page: "built-in", path: CHALLENGE_PATH,
      difficulty: { none: 8, low: 8, medium: 8, high: 8 }, challengeTtlSeconds: 120, passTtlMinutes: 30, noJs: false, waitSeconds: 10,
    });
    const none = await startTestVerify({ pub, challengeUrl: null });
    try {
      const plain = (await (await fetch(`${none.url}/status`)).json()) as { challenge: { enforced: boolean; page: string } };
      expect({ enforced: plain.challenge.enforced, page: plain.challenge.page }).toEqual({ enforced: false, page: "none" });
    } finally {
      await none.stop();
    }
  });

  test("US5-3: a pass and a refusal are logged in one line each, with nothing else about the client", async () => {
    const before = v.logs.length;
    const passed = await passChallenge(v, { client: tor, returnTo: "/login?secret=1" });
    const page = await getChallengePage(v, { client: tor, returnTo: "/login" });
    const s = wrongSolution(page.challenge!);
    await postAnswer(v, { client: tor, c: page.challenge!, s, r: "/login", headers: { "User-Agent": "UA-MARKER" } });
    const lines = v.logs.slice(before);
    expect(lines).toEqual([`challenge: pass ${tor} kind=pow bits=8`, `challenge: refused ${tor} reason=solution bits=8`]);
    for (const line of lines) {
      for (const secret of [passed.pass!, "UA-MARKER", "secret=1", page.challenge!]) expect(line.includes(secret)).toBe(false);
    }
  });

  test("US5-4: the challenge routes are exempt from the policy in every proxy mode, so there is no loop", async () => {
    for (const mode of PROXY_MODES) {
      for (const uri of [`${CHALLENGE_PATH}?return=%2Flogin`, `${CHALLENGE_PATH}/page.js`, `${CHALLENGE_PATH}/worker.js`, `${CHALLENGE_PATH}/wait?c=x`]) {
        const r = await forwardAuth(v, { mode, client: tor, uri });
        expect({ mode, uri, status: r.status, action: r.action, reason: r.reason }).toEqual({
          mode, uri, status: 200, action: "allow", reason: "challenge-page",
        });
      }
    }
    const page = await getChallengePage(v, { client: tor, returnTo: "/login" });
    expect(page.status).toBe(200);
    expect(page.challenge).not.toBeNull();
  });
});
