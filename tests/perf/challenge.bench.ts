import { toIpValue, type IpValue } from "../../src/ip/parse";
import { checkAnswer, issueChallenge, readChallenge } from "../../src/verify/challenge/challenge";
import { solve } from "../../src/verify/challenge/pow";
import { createReplayCache } from "../../src/verify/challenge/replay";
import { DEFAULT_DIFFICULTY } from "../../src/verify/config";
import { issuePassTokenV2 } from "../../src/verify/token";
import { createTestPublication } from "../helpers/publication";
import { ADDR, CHALLENGE_PATH, CHALLENGE_SECRET, publishRecordedSnapshot, startTestVerify } from "../helpers/verify";
import { percentile, type Measurement } from "./util";

const SOLVES = 50;
const CHECKS = 10_000;
const REQUESTS = 5_000;

/**
 * Spec 006 measurements (research R10):
 * - SC-001 (desktop part): solve time per default level with the client solver in Bun; the
 *   phone and Tor Browser runs are manual (quickstart.md step 3.5).
 * - Server cost of checking one answer.
 * - SC-005: `/verify` p99 with a v2 pass cookie stays within the spec 002 target (< 5 ms).
 */
export async function measureChallenge(): Promise<Measurement[]> {
  const out: Measurement[] = [];
  const ip = toIpValue(ADDR.tor[4]) as IpValue;

  for (const level of ["low", "medium", "high"] as const) {
    const bits = DEFAULT_DIFFICULTY[level];
    const ms: number[] = [];
    let tried = 0;
    for (let i = 0; i < SOLVES; i++) {
      const nonce = crypto.getRandomValues(new Uint8Array(16));
      const t = performance.now();
      tried += Number(solve(nonce, bits)) + 1;
      ms.push(performance.now() - t);
    }
    const total = ms.reduce((a, b) => a + b, 0);
    const p95 = percentile(ms, 95);
    out.push({
      criterion: `006 SC-001 solve ${level} (${bits} bits, Bun)`,
      target: level === "medium" ? "p95 < 1 s" : "info",
      measured: `p50 ${percentile(ms, 50).toFixed(0)} ms, p95 ${p95.toFixed(0)} ms, ${(tried / total / 1000).toFixed(2)} MH/s`,
      pass: level !== "medium" || p95 < 1000,
    });
  }

  const now = new Date();
  const answers = Array.from({ length: CHECKS }, () => {
    const challenge = issueChallenge({ kind: "pow", ip, bits: 8, ttlSeconds: 120, secret: CHALLENGE_SECRET, now });
    const { nonce, bits } = readChallenge(challenge)!;
    return { challenge, solution: solve(nonce, bits).toString() };
  });
  const replay = createReplayCache();
  const checkMs: number[] = [];
  for (const { challenge, solution } of answers) {
    const t = performance.now();
    const result = checkAnswer({ challenge, solution, ip, secret: CHALLENGE_SECRET, noJs: false, replay, now });
    checkMs.push(performance.now() - t);
    if (!result.ok) throw new Error(`answer refused: ${result.reason}`);
  }
  const p99Check = percentile(checkMs, 99);
  out.push({
    criterion: "006 answer check p99",
    target: "< 1 ms",
    measured: `${(p99Check * 1000).toFixed(1)} µs (p50 ${(percentile(checkMs, 50) * 1000).toFixed(1)} µs, ${CHECKS} answers)`,
    pass: p99Check < 1,
  });

  const pub = await createTestPublication();
  try {
    await publishRecordedSnapshot(pub);
    const verify = await startTestVerify({ pub, challengeUrl: CHALLENGE_PATH, challengeSecret: CHALLENGE_SECRET });
    try {
      const pass = issuePassTokenV2(ip, 1800, CHALLENGE_SECRET);
      const timed = async (cookie: string | null) => {
        const ms: number[] = [];
        for (let i = 0; i < REQUESTS; i++) {
          const t = performance.now();
          const res = await fetch(`${verify.url}/verify?proxy=nginx`, {
            headers: { "X-Forwarded-For": ADDR.tor[4], "X-Forwarded-Uri": "/login", ...(cookie ? { Cookie: `foxtrust_pass=${cookie}` } : {}) },
            redirect: "manual",
          });
          await res.arrayBuffer();
          ms.push(performance.now() - t);
        }
        return ms;
      };
      await timed(null); // warm-up
      const without = await timed(null);
      const withPass = await timed(pass);
      const p99With = percentile(withPass, 99);
      out.push({
        criterion: "006 SC-005 /verify p99 with a v2 pass",
        target: "< 5 ms",
        measured: `${p99With.toFixed(2)} ms (without a pass ${percentile(without, 99).toFixed(2)} ms, ${REQUESTS} requests each)`,
        pass: p99With < 5,
      });
    } finally {
      await verify.stop();
    }
  } finally {
    await pub.stop();
  }
  return out;
}

if (import.meta.main) console.table(await measureChallenge());
