import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toIpValue, type IpValue } from "../../src/ip/parse";
import { issuePassToken } from "../../src/verify/token";
import { createTestPublication, type TestPublication } from "../helpers/publication";
import { ADDR, EXAMPLE_POLICY, forwardAuth, PROXY_MODES, publishRecordedSnapshot, startTestVerify, type TestVerify } from "../helpers/verify";

const POLICIES = join(import.meta.dir, "..", "fixtures", "policies");
const SECRET = "test-challenge-secret-0123456789abcdef";
type Status = { policy: { lastError: string | null; rules: number } };
const statusOf = async (v: TestVerify) => (await (await fetch(`${v.url}/status`)).json()) as Status;
const FAMILIES = [4, 6] as const;

describe("US3: policies and /verify for forward-auth", () => {
  let pub: TestPublication;
  let version: string;
  const started: TestVerify[] = [];
  const start = async (opts: Parameters<typeof startTestVerify>[0]) => {
    const v = await startTestVerify(opts);
    started.push(v);
    return v;
  };

  beforeAll(async () => {
    pub = await createTestPublication();
    version = await publishRecordedSnapshot(pub);
  });

  afterAll(async () => {
    for (const v of started) await v.stop();
    await pub?.stop();
  });

  test("US3-1: a Tor exit on /login is sent to the challenge URL with /login as the return address (IPv4/IPv6)", async () => {
    const v = await start({ pub });
    for (const mode of PROXY_MODES) {
      for (const family of FAMILIES) {
        const r = await forwardAuth(v, { mode, client: ADDR.tor[family], uri: "/login" });
        const expectedLocation = `https://challenge.example/pass?return=${encodeURIComponent("/login")}`;
        expect({ mode, family, action: r.action, rule: r.rule, reason: r.reason, snapshot: r.snapshot, risk: r.risk }).toEqual({
          mode, family, action: "challenge", rule: "tor-on-login", reason: "rule", snapshot: version, risk: "34.3",
        });
        if (mode === "nginx") {
          expect(r.status).toBe(401);
          expect(r.challengeLocation).toBe(expectedLocation);
          expect(r.location).toBeNull();
        } else {
          expect(r.status).toBe(302);
          expect(r.location).toBe(expectedLocation);
        }
      }
    }
    // With the forwarded host and protocol, the return address is the full original URL.
    const full = await forwardAuth(v, {
      mode: "traefik", client: ADDR.tor[4], uri: "/login?next=%2F",
      headers: { "X-Forwarded-Host": "app.example", "X-Forwarded-Proto": "https" },
    });
    expect(full.location).toBe(`https://challenge.example/pass?return=${encodeURIComponent("https://app.example/login?next=%2F")}`);
  });

  test("US3-2: an address that matches no rule gets the default action (IPv4/IPv6)", async () => {
    const v = await start({ pub });
    for (const mode of PROXY_MODES) {
      for (const family of FAMILIES) {
        for (const [client, risk] of [[ADDR.low[family], "12"], [ADDR.tor[family], "34.3"], [ADDR.unlisted[family], null]] as const) {
          const r = await forwardAuth(v, { mode, client, uri: "/" });
          expect({ mode, client, status: r.status, action: r.action, rule: r.rule, reason: r.reason, risk: r.risk }).toEqual({
            mode, client, status: 200, action: "allow", rule: "default", reason: "default", risk,
          });
        }
      }
      const blocked = await forwardAuth(v, { mode, client: ADDR.high[6], uri: "/" });
      expect({ status: blocked.status, rule: blocked.rule }).toEqual({ status: 403, rule: "high-risk" });
    }
  });

  test("US3-3: an invalid policy is rejected with the offending path; the previous policy stays active", async () => {
    const dir = await mkdtemp(join(tmpdir(), "foxtrust-policy-"));
    try {
      const file = join(dir, "policy.yaml");
      await copyFile(EXAMPLE_POLICY, file);
      const v = await start({ pub, policyFile: file });
      const stopWatch = v.policy.watch(100);
      try {
        for (const [bad, path] of [["invalid-unknown-category.yaml", "rules[0].when.categories[0]"], ["invalid-unknown-key.yaml", "rules[0].when"]] as const) {
          await copyFile(join(POLICIES, bad), file);
          let status: Status | null = null;
          for (let i = 0; i < 60; i++) {
            status = await statusOf(v);
            if (status.policy.lastError) break;
            await Bun.sleep(50);
          }
          expect(status!.policy.lastError).toContain(path);
          expect(status!.policy.rules).toBe(2);
          for (const mode of PROXY_MODES) {
            expect((await forwardAuth(v, { mode, client: ADDR.tor[4], uri: "/login" })).rule).toBe("tor-on-login");
          }
          // A valid file clears the error again.
          await copyFile(EXAMPLE_POLICY, file);
          for (let i = 0; i < 60 && (await statusOf(v)).policy.lastError; i++) await Bun.sleep(50);
          expect((await statusOf(v)).policy.lastError).toBeNull();
        }
      } finally {
        stopWatch();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("US3-4: X-Forwarded-For from a peer that is not a trusted proxy is ignored (IPv4/IPv6)", async () => {
    const untrusting = await start({ pub, trustedProxies: [] });
    for (const mode of PROXY_MODES) {
      for (const family of FAMILIES) {
        const r = await forwardAuth(untrusting, { mode, client: ADDR.tor[family], uri: "/login" });
        // The peer (127.0.0.1) has no record, so the default applies.
        expect({ mode, family, status: r.status, rule: r.rule, risk: r.risk }).toEqual({ mode, family, status: 200, rule: "default", risk: null });
      }
    }
  });

  test("US3-5: without a snapshot, fail-open allows and fail-closed blocks; both are marked as no data", async () => {
    const open = await start({ pub: null, failMode: "open" });
    const closed = await start({ pub: null, failMode: "closed" });
    for (const mode of PROXY_MODES) {
      const a = await forwardAuth(open, { mode, client: ADDR.tor[4], uri: "/login" });
      expect({ mode, status: a.status, action: a.action, reason: a.reason, noData: a.noData, snapshot: a.snapshot }).toEqual({
        mode, status: 200, action: "allow", reason: "no-data", noData: "1", snapshot: "none",
      });
      const b = await forwardAuth(closed, { mode, client: ADDR.tor[6], uri: "/login" });
      expect({ mode, status: b.status, action: b.action, noData: b.noData }).toEqual({ mode, status: 403, action: "block", noData: "1" });
    }
    expect((await fetch(`${closed.url}/healthz`)).status).toBe(503);
    expect((await fetch(`${open.url}/healthz`)).status).toBe(200);
  });

  test("US3-6: a valid pass token turns the challenge into allow (IPv4/IPv6)", async () => {
    const v = await start({ pub, challengeSecret: SECRET });
    for (const mode of PROXY_MODES) {
      for (const family of FAMILIES) {
        const token = issuePassToken(toIpValue(ADDR.tor[family]) as IpValue, 600, SECRET);
        for (const headers of [{ Cookie: `other=1; foxtrust_pass=${token}` }, { "X-FoxTrust-Pass": token }]) {
          const r = await forwardAuth(v, { mode, client: ADDR.tor[family], uri: "/login", headers });
          expect({ mode, family, status: r.status, action: r.action, reason: r.reason, rule: r.rule }).toEqual({
            mode, family, status: 200, action: "allow", reason: "challenge-pass", rule: "tor-on-login",
          });
        }
      }
    }
  });

  test("US3-7: without a challenge URL, challenge falls back to allow and the case is logged (IPv4/IPv6)", async () => {
    const v = await start({ pub, challengeUrl: null });
    for (const mode of PROXY_MODES) {
      for (const family of FAMILIES) {
        const r = await forwardAuth(v, { mode, client: ADDR.tor[family], uri: "/login" });
        expect({ mode, family, status: r.status, action: r.action, reason: r.reason, location: r.location }).toEqual({
          mode, family, status: 200, action: "allow", reason: "challenge-fallback", location: null,
        });
      }
    }
    expect(v.logs.filter((l) => l.includes("challenge not enforced")).length).toBe(PROXY_MODES.length * FAMILIES.length);
  });
});
