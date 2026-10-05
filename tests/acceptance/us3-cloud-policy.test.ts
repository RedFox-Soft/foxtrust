import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activateConfig } from "../../src/db/versions";
import { loadConfig } from "../../src/scoring/config";
import { buildAndRelease } from "../../src/snapshot/publish";
import { loadSigningKey } from "../../src/snapshot/sign";
import { describeDb, withTestDb } from "../helpers/db";
import { CLOUD_CONFIG, ingestCloudFixture, loadFixtureDataset } from "../helpers/fixture-data";
import { createTestPublication, type TestPublication } from "../helpers/publication";
import { forwardAuth, startTestVerify, type TestVerify } from "../helpers/verify";

const CLOUD = { 4: "3.5.140.2", 6: "2001:671:fc00::1" } as const;
const NOT_CLOUD = { 4: "9.9.9.9", 6: "2620:fe::fe" } as const;
const POLICY = `version: 1
default: allow
rules:
  - name: cloud-on-login
    when:
      categories: [cloud]
      path: "/login*"
    action: challenge
`;

describeDb("US3 (spec 005): policies can act on cloud traffic", () => {
  const db = withTestDb();
  let tmp: string;
  let pub: TestPublication;
  let verify: TestVerify;
  let policyFile: string;

  beforeAll(async () => {
    tmp = await mkdtemp(join(tmpdir(), "foxtrust-005-us3-"));
    await loadFixtureDataset(db.sql);
    await ingestCloudFixture(db.sql);
    await activateConfig(db.sql, await loadConfig(CLOUD_CONFIG));
    pub = await createTestPublication();
    const result = await buildAndRelease(db.sql, "full", {
      dir: pub.dir, workDir: join(tmp, "work"), key: await loadSigningKey(pub.signingKeyPath),
      disputeUrl: "https://foxtrust.example/dispute", sample: 50,
    });
    if (result.status !== "published") throw new Error(`release: ${JSON.stringify(result)}`);
    policyFile = join(tmp, "policy.yaml");
    await Bun.write(policyFile, POLICY);
    verify = await startTestVerify({ pub, policyFile });
  }, 300_000);

  afterAll(async () => {
    await verify?.stop();
    await pub?.stop();
    if (tmp) await rm(tmp, { recursive: true, force: true });
  });

  test("US3-1: a cloud address on /login gets the rule's action and the rule is named (IPv4/IPv6)", async () => {
    for (const family of [4, 6] as const) {
      const r = await forwardAuth(verify, { mode: "traefik", client: CLOUD[family], uri: "/login" });
      expect({ family, action: r.action, rule: r.rule, status: r.status }).toEqual({ family, action: "challenge", rule: "cloud-on-login", status: 302 });
    }
  });

  test("US3-2: a non-cloud address on /login and a cloud address elsewhere do not match the rule (IPv4/IPv6)", async () => {
    for (const family of [4, 6] as const) {
      const other = await forwardAuth(verify, { mode: "traefik", client: NOT_CLOUD[family], uri: "/login" });
      const elsewhere = await forwardAuth(verify, { mode: "traefik", client: CLOUD[family], uri: "/home" });
      for (const r of [other, elsewhere]) expect({ family, action: r.action, rule: r.rule }).toEqual({ family, action: "allow", rule: "default" });
    }
  });

  test("US3-3: policy check accepts a rule on the cloud category", async () => {
    const proc = Bun.spawn(["bun", "run", "src/cli/main.ts", "policy", "check", policyFile], { stdout: "pipe", stderr: "pipe" });
    const exit = await proc.exited;
    expect({ exit, stderr: await new Response(proc.stderr).text() }).toEqual({ exit: 0, stderr: "" });
  });
});
