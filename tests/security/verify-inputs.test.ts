import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toIpValue, type IpValue } from "../../src/ip/parse";
import { MAX_POLICY_BYTES, parsePolicy, PolicyError, vocabularyFromConfig } from "../../src/policy";
import { loadConfig } from "../../src/scoring/config";
import { createPolicyHolder } from "../../src/verify/policy-file";
import { issuePassToken } from "../../src/verify/token";
import { STAGE2_CONFIG } from "../helpers/fixture-data";
import { createTestPublication, type TestPublication } from "../helpers/publication";
import { ADDR, forwardAuth, PROXY_MODES, publishRecordedSnapshot, startTestVerify, type TestVerify } from "../helpers/verify";

const SECRET = "test-challenge-secret-0123456789abcdef";
const ip = (text: string) => toIpValue(text) as IpValue;

describe("SEC: /verify inputs", () => {
  let pub: TestPublication;
  let v: TestVerify;
  let noProxies: TestVerify;

  beforeAll(async () => {
    pub = await createTestPublication();
    await publishRecordedSnapshot(pub);
    v = await startTestVerify({ pub, challengeSecret: SECRET });
    noProxies = await startTestVerify({ pub, challengeSecret: SECRET, trustedProxies: [] });
  });

  afterAll(async () => {
    await v?.stop();
    await noProxies?.stop();
    await pub?.stop();
  });

  /** A challenge the token did not lift: the pass was ignored. */
  async function expectIgnored(token: string, client: string = ADDR.tor[4]) {
    for (const mode of PROXY_MODES) {
      for (const headers of [{ Cookie: `foxtrust_pass=${token}` }, { "X-FoxTrust-Pass": token }]) {
        const r = await forwardAuth(v, { mode, client, uri: "/login", headers });
        expect({ mode, action: r.action, reason: r.reason }).toEqual({ mode, action: "challenge", reason: "rule" });
      }
    }
  }

  test("SEC: spoofed X-Forwarded-For from an untrusted peer is ignored", async () => {
    for (const mode of PROXY_MODES) {
      // An untrusted peer's header is ignored: the peer itself (no record) is looked up.
      const claimed = await forwardAuth(noProxies, { mode, client: ADDR.low[4], uri: "/" });
      expect({ mode, risk: claimed.risk, rule: claimed.rule }).toEqual({ mode, risk: null, rule: "default" });
      // Through a trusted proxy, a client-supplied entry left of the real client is ignored.
      const chained = await forwardAuth(v, { mode, client: `${ADDR.low[4]}, ${ADDR.tor[6]}`, uri: "/login" });
      expect({ mode, rule: chained.rule, risk: chained.risk }).toEqual({ mode, rule: "tor-on-login", risk: "34.3" });
      // Garbage in the header does not become an address.
      const garbage = await forwardAuth(v, { mode, client: "not-an-ip, 999.1.1.1", uri: "/login" });
      expect({ mode, rule: garbage.rule, risk: garbage.risk }).toEqual({ mode, rule: "default", risk: null });
    }
  });

  test("SEC: forged pass token is ignored", async () => {
    const real = issuePassToken(ip(ADDR.tor[4]), 600, SECRET);
    const [payload, mac] = real.split(".") as [string, string];
    await expectIgnored(issuePassToken(ip(ADDR.tor[4]), 600, "another-secret-of-sufficient-length-000"));
    await expectIgnored(`${payload}.${mac.slice(0, -2)}AA`);
    const otherPayload = Buffer.from(JSON.stringify({ ip: ADDR.tor[4], exp: 9_999_999_999, v: 1 })).toString("base64url");
    await expectIgnored(`${otherPayload}.${mac}`);
    for (const junk of ["", ".", "abc", `${payload}.`, `.${mac}`, `${payload}.${mac}.x`, "x".repeat(5000)]) await expectIgnored(junk);
    // Sanity: the real token works.
    expect((await forwardAuth(v, { client: ADDR.tor[4], uri: "/login", headers: { "X-FoxTrust-Pass": real } })).reason).toBe("challenge-pass");
  });

  test("SEC: expired pass token is ignored", async () => {
    await expectIgnored(issuePassToken(ip(ADDR.tor[4]), 60, SECRET, new Date(Date.now() - 120_000)));
  });

  test("SEC: pass token for another address is ignored", async () => {
    await expectIgnored(issuePassToken(ip(ADDR.low[4]), 600, SECRET));
    await expectIgnored(issuePassToken(ip(ADDR.tor[6]), 600, SECRET), ADDR.tor[4]);
    await expectIgnored(issuePassToken(ip("::ffff:198.51.100.8"), 600, SECRET));
  });

  test("SEC: policy YAML bomb (alias expansion) is rejected within 1 s", async () => {
    const vocabulary = vocabularyFromConfig(await loadConfig(STAGE2_CONFIG));
    const bomb = [
      "a: &a [x, x, x, x, x, x, x, x, x, x]",
      ...Array.from({ length: 9 }, (_, i) => `${String.fromCharCode(98 + i)}: &${String.fromCharCode(98 + i)} [${Array(10).fill(`*${String.fromCharCode(97 + i)}`).join(", ")}]`),
      "version: 1", "default: allow", "rules: *j",
    ].join("\n");
    for (const text of [bomb, `version: 1\ndefault: allow\nrules: [&r {name: x, when: {noData: true}, action: block}, *r]`]) {
      const started = performance.now();
      expect(() => parsePolicy(text, vocabulary)).toThrow(PolicyError);
      expect(performance.now() - started).toBeLessThan(1000);
    }
  });

  test("SEC: policy over 256 KB is rejected", async () => {
    const vocabulary = vocabularyFromConfig(await loadConfig(STAGE2_CONFIG));
    const big = `version: 1\ndefault: allow\nrules: []\n# ${"x".repeat(MAX_POLICY_BYTES)}\n`;
    expect(() => parsePolicy(big, vocabulary)).toThrow(PolicyError);

    // Through the file loader too, and the running policy stays.
    const dir = await mkdtemp(join(tmpdir(), "foxtrust-bigpolicy-"));
    try {
      const file = join(dir, "policy.yaml");
      await Bun.write(file, "version: 1\ndefault: block\nrules: []\n");
      const holder = createPolicyHolder(file, vocabulary);
      expect(await holder.load()).toBe(true);
      await Bun.write(file, big);
      expect(await holder.load()).toBe(false);
      expect(holder.status().lastError).toContain(`larger than ${MAX_POLICY_BYTES} bytes`);
      expect(holder.current()?.default).toBe("block");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
