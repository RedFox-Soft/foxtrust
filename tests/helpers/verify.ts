import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { parseCidr, type Cidr } from "../../src/ip/cidr";
import { MmdbWriter, type MmdbValue } from "../../src/mmdb/writer";
import { vocabularyFromConfig, type Action } from "../../src/policy";
import { loadConfig } from "../../src/scoring/config";
import { SNAPSHOT_DB_TYPE } from "../../src/snapshot/build";
import { importTrustedKeys, loadSigningKey, sign } from "../../src/snapshot/sign";
import { readdirSync } from "node:fs";
import { loadBotDeps } from "../../src/verify/bot/load";
import { DEFAULT_BOT_POLICY, type BotPolicy } from "../../src/verify/bot/policy";
import type { ProbeResult } from "../../src/verify/bot/probe-types";
import { buildChallengeAssets } from "../../src/verify/challenge/assets";
import { readChallenge } from "../../src/verify/challenge/challenge";
import { leadingZeroBits, sha256Block, solve } from "../../src/verify/challenge/pow";
import { createReplayCache } from "../../src/verify/challenge/replay";
import { DEFAULT_CHALLENGE, DEFAULT_DEVICE, type ChallengeSettings, type DifficultyKey } from "../../src/verify/config";
import { createDeviceStore, type DeviceStore } from "../../src/verify/device/store";
import { tmpdir } from "node:os";
import { createLoader, type Loader } from "../../src/verify/loader";
import { createPolicyHolder, type PolicyHolder } from "../../src/verify/policy-file";
import { startVerifyServer } from "../../src/verify/server";
import { STAGE2_CONFIG } from "./fixture-data";
import type { TestPublication } from "./publication";

export const EXAMPLE_POLICY = join(import.meta.dir, "..", "fixtures", "policies", "example.yaml");
export const LOOPBACK: Cidr[] = [parseCidr("127.0.0.1/32")!, parseCidr("::1/128")!];
export const PROXY_MODES = ["nginx", "traefik", "caddy"] as const;
export const CHALLENGE_PATH = "/.foxtrust/challenge";
export const CHALLENGE_SECRET = "test-challenge-secret-0123456789abcdef";
/** Tests solve at 8 bits on every level unless they set a difficulty. */
export const TEST_DIFFICULTY: Record<DifficultyKey, number> = { none: 8, low: 8, medium: 8, high: 8 };

/** Addresses in the recorded snapshot below, per family. */
export const ADDR = {
  tor: { 4: "198.51.100.7", 6: "2001:db8:1::7" },
  high: { 4: "203.0.113.9", 6: "2001:db8:2::9" },
  low: { 4: "192.0.2.20", 6: "2001:db8:3::20" },
  cloud: { 4: "198.18.0.5", 6: "2001:db8:4::5" },
  unlisted: { 4: "100.64.0.1", 6: "2001:db8:ffff::1" },
  /** A clean residential range with a country (spec 007: time-zone checks). */
  residential: { 4: "198.19.0.10", 6: "2001:db8:5::10" },
} as const;

const SEEN = Math.floor(Date.now() / 1000) - 3600;
const record = (risk: number, level: string, categories: string[], codes: string[], network: Record<string, MmdbValue> = {}): MmdbValue => ({
  risk, level, categories, reasons: codes.map((code) => ({ code, last_seen: SEEN, contribution: risk / codes.length })), network,
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
  const residential = record(0, "low", [], [], { country: "DE" });
  for (const [cidr, value] of [
    ["198.51.100.0/24", tor], ["2001:db8:1::/48", tor],
    ["203.0.113.0/24", high], ["2001:db8:2::/48", high],
    ["192.0.2.0/24", low], ["2001:db8:3::/48", low],
    ["198.18.0.0/24", cloud], ["2001:db8:4::/48", cloud],
    ["198.19.0.0/24", residential], ["2001:db8:5::/48", residential],
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
  /** Settings of the built-in page; used when `challengeUrl` is a path. */
  challenge?: Partial<Omit<ChallengeSettings, "page" | "path">>;
  replayCap?: number;
  clock?: () => Date;
  /** Bot verdict (spec 007); off unless a test sets it, so spec 006 tests see no verdict. */
  bot?: Partial<BotPolicy> & { weightsFile?: string; ja4FamiliesFile?: string };
  /** Returning-device token (spec 008); off unless a test sets it. */
  device?: Partial<{ enabled: boolean; ttlDays: number; cap: number }>;
  /** State file of the device store; a fresh temporary file by default. */
  deviceStateFile?: string;
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
  const challengeUrl = opts.challengeUrl === undefined ? "https://challenge.example/pass" : opts.challengeUrl;
  const builtIn = challengeUrl?.startsWith("/") ?? false;
  const challenge: ChallengeSettings = {
    ...DEFAULT_CHALLENGE,
    difficulty: TEST_DIFFICULTY,
    ...opts.challenge,
    page: !challengeUrl ? "none" : builtIn ? "built-in" : "external",
    path: builtIn ? challengeUrl : null,
  };
  let deviceStore: { settings: typeof DEFAULT_DEVICE; store: DeviceStore } | null = null;
  if (builtIn && opts.device && opts.device.enabled !== false) {
    const settings = {
      ...DEFAULT_DEVICE, ...opts.device, enabled: true,
      stateFile: opts.deviceStateFile ?? join(tmpdir(), `foxtrust-device-${crypto.randomUUID()}.json`),
    };
    const store = createDeviceStore({ file: settings.stateFile, secret: opts.challengeSecret ?? "", cap: settings.cap });
    await store.load();
    deviceStore = { settings, store };
  }
  const server = startVerifyServer({
    loader, policy, port: 0, hostname: "127.0.0.1", log: (l) => logs.push(l),
    ...(builtIn ? { challengeAssets: await buildChallengeAssets() } : {}),
    ...(opts.replayCap ? { replay: createReplayCache(opts.replayCap) } : {}),
    bot: builtIn && opts.bot
      ? await loadBotDeps({
          ...DEFAULT_BOT_POLICY, mode: "enforce", hold: false, ...opts.bot,
          weightsFile: opts.bot.weightsFile ?? null, ja4FamiliesFile: opts.bot.ja4FamiliesFile ?? null,
        })
      : null,
    ...(opts.clock ? { clock: opts.clock } : {}),
    device: deviceStore,
    config: {
      trustedProxies: opts.trustedProxies ?? LOOPBACK,
      failMode: opts.failMode ?? "open",
      challengeUrl,
      challengeFallback: opts.challengeFallback ?? "allow",
      challengeSecret: opts.challengeSecret ?? null,
      challenge,
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

/** A browser visiting the challenge page through a trusted proxy (loopback) from `client`. */
export async function getChallengePage(v: TestVerify, opts: { client: string; returnTo?: string; headers?: Record<string, string> }) {
  const query = opts.returnTo === undefined ? "" : `?return=${encodeURIComponent(opts.returnTo)}`;
  const res = await fetch(`${v.url}${CHALLENGE_PATH}${query}`, { headers: { "X-Forwarded-For": opts.client, ...opts.headers }, redirect: "manual" });
  const html = await res.text();
  const field = (name: string) => unescapeHtml(new RegExp(`name="${name}" value="([^"]*)"`).exec(html)?.[1] ?? "") || null;
  const refresh = /<meta http-equiv="refresh" content="(\d+);url=([^"]+)">/.exec(html);
  const waitUrl = refresh ? unescapeHtml(refresh[2]!) : null;
  return {
    status: res.status,
    headers: res.headers,
    html,
    challenge: field("c"),
    returnTo: field("r"),
    waitSeconds: refresh ? Number(refresh[1]) : null,
    waitUrl,
    waitChallenge: waitUrl ? new URL(waitUrl, "http://x").searchParams.get("c") : null,
  };
}

export function unescapeHtml(text: string): string {
  return text.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

/** The counter a browser's worker would find for this challenge. */
export function solveChallenge(challenge: string): string {
  const payload = readChallenge(challenge);
  if (!payload) throw new Error("not a challenge");
  return solve(payload.nonce, payload.bits).toString();
}

/** A counter that does not meet the challenge's difficulty. */
export function wrongSolution(challenge: string): string {
  const payload = readChallenge(challenge);
  if (!payload) throw new Error("not a challenge");
  for (let s = 0n; ; s++) if (leadingZeroBits(sha256Block(payload.nonce, s)) < payload.bits) return s.toString();
}

export type AnswerResponse = {
  status: number;
  location: string | null;
  /** The pass cookie line, if one was set. */
  cookie: string | null;
  pass: string | null;
  /** The returning-device cookie line (spec 008), if one was set or cleared. */
  deviceCookie: string | null;
  /** The device token value, "deleted" when the response cleared it, or null. */
  device: string | null;
  html: string;
};

async function answerResponse(res: Response): Promise<AnswerResponse> {
  const lines = res.headers.getSetCookie();
  const cookie = lines.find((l) => l.startsWith("foxtrust_pass=")) ?? null;
  const deviceCookie = lines.find((l) => l.startsWith("foxtrust_device=")) ?? null;
  const deviceValue = deviceCookie ? (/^foxtrust_device=([^;]*)/.exec(deviceCookie)?.[1] ?? "") : null;
  return {
    status: res.status,
    location: res.headers.get("location"),
    cookie,
    pass: cookie ? (/^foxtrust_pass=([^;]+)/.exec(cookie)?.[1] ?? null) : null,
    deviceCookie,
    device: deviceValue === null ? null : deviceValue === "" ? "deleted" : deviceValue,
    html: await res.text(),
  };
}

/** Posts a proof-of-work answer as the page's form would. */
export async function postAnswer(
  v: TestVerify,
  opts: { client: string; c: string; s: string; r?: string; headers?: Record<string, string>; body?: string },
): Promise<AnswerResponse> {
  const body = opts.body ?? new URLSearchParams({ c: opts.c, s: opts.s, r: opts.r ?? "/" }).toString();
  const res = await fetch(`${v.url}${CHALLENGE_PATH}`, {
    method: "POST",
    body,
    headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Forwarded-For": opts.client, ...opts.headers },
    redirect: "manual",
  });
  return answerResponse(res);
}

/** Follows a no-JavaScript refresh URL (relative to the page). */
export async function getWait(v: TestVerify, opts: { client: string; url: string }): Promise<AnswerResponse> {
  const res = await fetch(`${v.url}${opts.url}`, { headers: { "X-Forwarded-For": opts.client }, redirect: "manual" });
  return answerResponse(res);
}

/** Fetches the page, solves it and answers: the whole browser flow. */
export async function passChallenge(v: TestVerify, opts: { client: string; returnTo?: string }): Promise<AnswerResponse> {
  const page = await getChallengePage(v, opts);
  if (!page.challenge) throw new Error(`no challenge on the page (status ${page.status})`);
  return postAnswer(v, { client: opts.client, c: page.challenge, s: solveChallenge(page.challenge), r: page.returnTo ?? "/" });
}

/** A recorded probe sample of the bot-verdict labelled set (spec 007 data-model "Labelled sample"). */
export type BotSample = {
  label: string;
  kind: "human" | "automation";
  tool: string;
  version: string;
  recordedAt: string;
  addressKind: "residential" | "tor" | "cloud";
  headers: Record<string, string>;
  probe: ProbeResult;
  /** Hold-step input (spec 009), with n = "*". */
  behavior?: Record<string, unknown>;
  inputKind?: string;
};

export const BOT_SAMPLES = join(import.meta.dir, "..", "fixtures", "bot-samples");

/** The `index`-th recorded sample of `label` (sorted by file name). */
export async function loadSample(label: string, index = 0): Promise<BotSample> {
  const files = readdirSync(join(BOT_SAMPLES, label)).filter((f) => f.endsWith(".json")).sort();
  const file = files[index];
  if (!file) throw new Error(`no sample ${index} for ${label}`);
  return (await Bun.file(join(BOT_SAMPLES, label, file)).json()) as BotSample;
}

/** The fixture address a sample's address kind stands for. */
export function sampleAddress(sample: Pick<BotSample, "addressKind">): string {
  return sample.addressKind === "tor" ? ADDR.tor[4] : sample.addressKind === "cloud" ? ADDR.cloud[4] : ADDR.residential[4];
}

/** Request headers a browser would send with this sample, as seen behind a trusted proxy. */
export function sampleHeaders(sample: BotSample, extra: Record<string, string> = {}): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(sample.headers)) if (name !== "proto") headers[name] = value;
  headers["x-forwarded-proto"] = sample.headers.proto ?? "https";
  return { ...headers, ...extra };
}

export type SampleAnswer = AnswerResponse & { stepUpChallenge: string | null };

/**
 * The browser flow with a recorded sample: fetch the page as that browser, solve, and post the
 * answer with the sample's probe bound to the challenge (or `probe` to override, null for none).
 */
export async function answerWithSample(
  v: TestVerify,
  sample: BotSample,
  opts: {
    client?: string; headers?: Record<string, string>; probe?: Partial<ProbeResult> | null | string; challenge?: string;
    /** Hold input: an object merged over the sample's, a raw string, or null to omit it. */
    behavior?: Record<string, unknown> | null | string;
  } = {},
): Promise<SampleAnswer> {
  const client = opts.client ?? sampleAddress(sample);
  const headers = sampleHeaders(sample, opts.headers);
  const challenge = opts.challenge ?? (await getChallengePage(v, { client, returnTo: "/login", headers })).challenge;
  if (!challenge) throw new Error("no challenge on the page");
  const nonce = Buffer.from(readChallenge(challenge)!.nonce).toString("base64url");
  const p = opts.probe === null ? undefined : typeof opts.probe === "string" ? opts.probe : JSON.stringify({ ...sample.probe, n: nonce, ...opts.probe });
  const b = opts.behavior === null ? undefined
    : typeof opts.behavior === "string" ? opts.behavior
    : sample.behavior || opts.behavior ? JSON.stringify({ ...sample.behavior, ...opts.behavior, n: nonce }) : undefined;
  const body = new URLSearchParams({ c: challenge, s: solveChallenge(challenge), r: "/login", ...(p === undefined ? {} : { p }), ...(b === undefined ? {} : { b }) }).toString();
  const answer = await postAnswer(v, { client, c: challenge, s: "", body, headers });
  return { ...answer, stepUpChallenge: /name="c" value="([^"]+)"/.exec(answer.html)?.[1] ?? null };
}
