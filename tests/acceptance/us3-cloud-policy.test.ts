import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestPublication, type TestPublication } from "../helpers/publication";
import { ADDR, forwardAuth, publishRecordedSnapshot, startTestVerify, type TestVerify } from "../helpers/verify";

// /verify reads only the published snapshot, so a recorded one with a cloud range is enough here.
// That cloud prefixes reach the snapshot as category `cloud` is US1-3 of us1-cloud-category.test.ts.
const POLICY = `version: 1
default: allow
rules:
  - name: cloud-on-login
    when:
      categories: [cloud]
      path: "/login*"
    action: challenge
`;

describe("US3 (spec 005): policies can act on cloud traffic", () => {
  let tmp: string;
  let pub: TestPublication;
  let verify: TestVerify;
  let policyFile: string;

  beforeAll(async () => {
    tmp = await mkdtemp(join(tmpdir(), "foxtrust-005-us3-"));
    pub = await createTestPublication();
    await publishRecordedSnapshot(pub);
    policyFile = join(tmp, "policy.yaml");
    await Bun.write(policyFile, POLICY);
    verify = await startTestVerify({ pub, policyFile });
  });

  afterAll(async () => {
    await verify?.stop();
    await pub?.stop();
    if (tmp) await rm(tmp, { recursive: true, force: true });
  });

  test("US3-1: a cloud address on /login gets the rule's action and the rule is named (IPv4/IPv6)", async () => {
    for (const family of [4, 6] as const) {
      const r = await forwardAuth(verify, { mode: "traefik", client: ADDR.cloud[family], uri: "/login" });
      expect({ family, action: r.action, rule: r.rule, status: r.status }).toEqual({ family, action: "challenge", rule: "cloud-on-login", status: 302 });
    }
  });

  test("US3-2: a non-cloud address on /login and a cloud address elsewhere do not match the rule (IPv4/IPv6)", async () => {
    for (const family of [4, 6] as const) {
      const other = await forwardAuth(verify, { mode: "traefik", client: ADDR.low[family], uri: "/login" });
      const elsewhere = await forwardAuth(verify, { mode: "traefik", client: ADDR.cloud[family], uri: "/home" });
      for (const r of [other, elsewhere]) expect({ family, action: r.action, rule: r.rule }).toEqual({ family, action: "allow", rule: "default" });
    }
  });

  test("US3-3: policy check accepts a rule on the cloud category", async () => {
    const proc = Bun.spawn(["bun", "run", "src/cli/main.ts", "policy", "check", policyFile], { stdout: "pipe", stderr: "pipe" });
    const exit = await proc.exited;
    expect({ exit, stderr: await new Response(proc.stderr).text() }).toEqual({ exit: 0, stderr: "" });
  });
});
