import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { parseCidr, type Cidr } from "../../src/ip/cidr";
import { MmdbWriter, type MmdbValue } from "../../src/mmdb/writer";
import { vocabularyFromConfig, type Action } from "../../src/policy";
import { loadConfig } from "../../src/scoring/config";
import { SNAPSHOT_DB_TYPE } from "../../src/snapshot/build";
import { importTrustedKeys, loadSigningKey, sign } from "../../src/snapshot/sign";
import { createLoader, type Loader } from "../../src/verify/loader";
import { createPolicyHolder, type PolicyHolder } from "../../src/verify/policy-file";
import { startVerifyServer } from "../../src/verify/server";
import { STAGE2_CONFIG } from "./fixture-data";
import type { TestPublication } from "./publication";

export const EXAMPLE_POLICY = join(import.meta.dir, "..", "fixtures", "policies", "example.yaml");
export const LOOPBACK: Cidr[] = [parseCidr("127.0.0.1/32")!, parseCidr("::1/128")!];
export const PROXY_MODES = ["nginx", "traefik", "caddy"] as const;

/** Addresses in the recorded snapshot below, per family. */
export const ADDR = {
  tor: { 4: "198.51.100.7", 6: "2001:db8:1::7" },
  high: { 4: "203.0.113.9", 6: "2001:db8:2::9" },
  low: { 4: "192.0.2.20", 6: "2001:db8:3::20" },
  cloud: { 4: "198.18.0.5", 6: "2001:db8:4::5" },
  unlisted: { 4: "100.64.0.1", 6: "2001:db8:ffff::1" },
} as const;

const SEEN = Math.floor(Date.now() / 1000) - 3600;
const record = (risk: number, level: string, categories: string[], codes: string[]): MmdbValue => ({
  risk, level, categories, reasons: codes.map((code) => ({ code, last_seen: SEEN, contribution: risk / codes.length })), network: {},
});

/** Publishes a small signed customer snapshot (Tor, high-risk, low-risk and cloud ranges) to `pub`. */
export async function publishRecordedSnapshot(pub: TestPublication, version = "f20261001"): Promise<string> {
  const writer = new MmdbWriter({
    databaseType: SNAPSHOT_DB_TYPE, description: { en: "recorded test snapshot" }, languages: ["en"],
    doubleKeys: ["risk", "contribution"], buildEpoch: SEEN,
  });
  const tor = record(34.3, "medium", ["tor"], ["tor_exit"]);
  const high = record(82, "high", ["hosting"], ["hosting", "botnet_c2"]);
  const low = record(12, "low", ["hosting"], ["hosting"]);
  const cloud = record(9, "low", ["cloud"], ["cloud"]);
  for (const [cidr, value] of [
    ["198.51.100.0/24", tor], ["2001:db8:1::/48", tor],
    ["203.0.113.0/24", high], ["2001:db8:2::/48", high],
    ["192.0.2.0/24", low], ["2001:db8:3::/48", low],
    ["198.18.0.0/24", cloud], ["2001:db8:4::/48", cloud],
  ] as const) writer.insert(parseCidr(cidr)!, value);
  const bytes = writer.build();
  const key = await loadSigningKey(pub.signingKeyPath);
  const path = `v1/full/${version}.mmdb`;
  await mkdir(join(pub.dir, "v1", "full"), { recursive: true });
  await Bun.write(join(pub.dir, path), bytes);
  await Bun.write(join(pub.dir, `${path}.sig`), await sign(bytes, key));
  const manifest = new TextEncoder().encode(JSON.stringify({
    format: 1, generatedAt: new Date().toISOString(), delta: null, keys: [], notices: [], disputeUrl: "https://foxtrust.example/dispute",
    full: {
      version, path, sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"), size: bytes.length,
      builtAt: new Date(SEEN * 1000).toISOString(), dataVersion: "dv1", algorithm: "noisy-or/1", configSha256: "0".repeat(64), keyId: key.keyId,
    },
  }));
  await Bun.write(join(pub.dir, "v1", "manifest.json"), manifest);
  await Bun.write(join(pub.dir, "v1", "manifest.json.sig"), await sign(manifest, key));
  return version;
}

export type TestVerify = { url: string; loader: Loader; policy: PolicyHolder; logs: string[]; stop: () => Promise<void> };

export async function startTestVerify(opts: {
  pub: TestPublication | null;
  policyFile?: string;
  trustedProxies?: Cidr[];
  failMode?: "open" | "closed";
  challengeUrl?: string | null;
  challengeFallback?: Action;
  challengeSecret?: string | null;
}): Promise<TestVerify> {
  const logs: string[] = [];
  const policy = createPolicyHolder(opts.policyFile ?? EXAMPLE_POLICY, vocabularyFromConfig(await loadConfig(STAGE2_CONFIG)), (l) => logs.push(l));
  if (!(await policy.load())) throw new Error(`policy: ${policy.status().lastError}`);
  const loader = createLoader({
    // Without a publication, a closed port: nothing ever loads.
    publicationUrl: opts.pub?.url ?? "http://127.0.0.1:1",
    trustedKeys: await importTrustedKeys(opts.pub ? [opts.pub.publicKey] : []),
    maxAgeHours: 26,
  });
  if (opts.pub) await loader.check();
  const server = startVerifyServer({
    loader, policy, port: 0, hostname: "127.0.0.1", log: (l) => logs.push(l),
    config: {
      trustedProxies: opts.trustedProxies ?? LOOPBACK,
      failMode: opts.failMode ?? "open",
      challengeUrl: opts.challengeUrl === undefined ? "https://challenge.example/pass" : opts.challengeUrl,
      challengeFallback: opts.challengeFallback ?? "allow",
      challengeSecret: opts.challengeSecret ?? null,
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, loader, policy, logs, stop: server.stop };
}

/** One forward-auth request as a proxy would send it. */
export async function forwardAuth(
  v: TestVerify,
  opts: { mode?: string; client?: string; uri?: string; method?: string; headers?: Record<string, string> } = {},
) {
  const headers: Record<string, string> = { "X-Forwarded-Uri": opts.uri ?? "/", "X-Forwarded-Method": opts.method ?? "GET", ...opts.headers };
  if (opts.client) headers["X-Forwarded-For"] = opts.client;
  const res = await fetch(`${v.url}/verify?proxy=${opts.mode ?? "traefik"}`, { headers, redirect: "manual" });
  await res.arrayBuffer();
  const h = (name: string) => res.headers.get(name);
  return {
    status: res.status,
    action: h("x-foxtrust-action"),
    rule: h("x-foxtrust-rule"),
    reason: h("x-foxtrust-reason"),
    risk: h("x-foxtrust-risk"),
    snapshot: h("x-foxtrust-snapshot"),
    noData: h("x-foxtrust-no-data"),
    location: h("location"),
    challengeLocation: h("x-foxtrust-challenge-location"),
  };
}
