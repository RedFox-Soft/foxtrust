import { join } from "node:path";
import { parseCidr, type Cidr } from "../ip/cidr";
import type { Level } from "../model/types";
import type { Action } from "../policy";

/**
 * `/verify` configuration from the environment (spec 002 contracts/verify-http.md; the built-in
 * challenge page: spec 006 contracts/challenge-http.md).
 */

export type DifficultyKey = Level | "none";

/** Settings of the built-in challenge page (spec 006 research R9). */
export type ChallengeSettings = {
  /** `built-in` when FOXTRUST_CHALLENGE_URL is a path, `external` for a URL, `none` when empty. */
  page: "none" | "built-in" | "external";
  /** The page's path when built in. */
  path: string | null;
  /** Proof-of-work bits per customer-verdict level; `none` = no record or no snapshot. */
  difficulty: Record<DifficultyKey, number>;
  challengeTtlSeconds: number;
  passTtlMinutes: number;
  noJs: boolean;
  waitSeconds: number;
};

export const DEFAULT_DIFFICULTY: Record<DifficultyKey, number> = { none: 14, low: 14, medium: 16, high: 18 };
export const DEFAULT_CHALLENGE: Omit<ChallengeSettings, "page" | "path"> = {
  difficulty: DEFAULT_DIFFICULTY,
  challengeTtlSeconds: 120,
  passTtlMinutes: 30,
  noJs: false,
  waitSeconds: 10,
};

export type VerifyConfig = {
  publicationUrl: string;
  trustedKeys: string[];
  policyFile: string;
  scoringConfigFile: string;
  trustedProxies: Cidr[];
  failMode: "open" | "closed";
  challengeUrl: string | null;
  challengeFallback: Action;
  challengeSecret: string | null;
  challenge: ChallengeSettings;
  maxAgeHours: number;
  updateEvery: string;
  port: number;
};

export class VerifyConfigError extends Error {}

const SCORING_DIR = join(import.meta.dir, "..", "..", "config", "scoring");

/** The newest shipped scoring config: its codes are the vocabulary policies may use. */
export function defaultScoringConfigFile(): string {
  const files = [...new Bun.Glob("*.json").scanSync({ cwd: SCORING_DIR })].sort();
  if (files.length === 0) throw new VerifyConfigError(`no scoring config in ${SCORING_DIR}`);
  return join(SCORING_DIR, files.at(-1)!);
}

const ACTIONS = ["allow", "challenge", "block"] as const;
const RESERVED_PATHS = ["/verify", "/status", "/healthz"];

/** A path the built-in page may live on (research R1): plain segments, no dot segments. */
export function challengePathProblem(path: string): string | null {
  if (path.length > 100 || !/^\/[A-Za-z0-9._~-]+(\/[A-Za-z0-9._~-]+)*$/.test(path)) {
    return "FOXTRUST_CHALLENGE_URL: a path must be /segment[/segment…] of letters, digits and ._~- (at most 100 characters)";
  }
  if (path.split("/").some((segment) => segment === "." || segment === "..")) return "FOXTRUST_CHALLENGE_URL: a path must not contain . or .. segments";
  if (RESERVED_PATHS.some((reserved) => path === reserved || path.startsWith(`${reserved}/`))) {
    return `FOXTRUST_CHALLENGE_URL: ${path} collides with a /verify endpoint`;
  }
  return null;
}

/** `none=14,low=14,…` merged over the defaults; bits 8–24, never fewer for a higher level. */
export function parseDifficulty(text: string | null, problems: string[]): Record<DifficultyKey, number> {
  const out = { ...DEFAULT_DIFFICULTY };
  for (const item of (text ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
    const match = /^(none|low|medium|high)=(\d{1,2})$/.exec(item);
    const bits = match ? Number(match[2]) : NaN;
    if (!match || bits < 8 || bits > 24) {
      problems.push(`FOXTRUST_CHALLENGE_DIFFICULTY: ${item} must be <none|low|medium|high>=<8–24>`);
      continue;
    }
    out[match[1] as DifficultyKey] = bits;
  }
  if (!(out.low <= out.medium && out.medium <= out.high)) {
    problems.push(`FOXTRUST_CHALLENGE_DIFFICULTY: a higher level must not get fewer bits (low=${out.low}, medium=${out.medium}, high=${out.high})`);
  }
  return out;
}

export function readVerifyConfig(env: Record<string, string | undefined> = Bun.env): VerifyConfig {
  const problems: string[] = [];
  const text = (name: string) => env[name]?.trim() || null;

  // There is no public FoxTrust publication yet, so the URL has no default.
  const publicationUrl = text("FOXTRUST_PUBLICATION_URL") ?? "";
  if (!publicationUrl) problems.push("FOXTRUST_PUBLICATION_URL is required");
  else {
    try {
      const url = new URL(publicationUrl);
      if (url.protocol !== "https:" && url.protocol !== "http:") problems.push("FOXTRUST_PUBLICATION_URL must be http(s)");
    } catch {
      problems.push("FOXTRUST_PUBLICATION_URL is not a URL");
    }
  }

  const trustedKeys = (text("FOXTRUST_TRUSTED_KEYS") ?? "").split(",").map((k) => k.trim()).filter(Boolean);
  if (trustedKeys.length === 0) problems.push("FOXTRUST_TRUSTED_KEYS is required (comma-separated base64 Ed25519 public keys)");
  const policyFile = text("FOXTRUST_POLICY_FILE");
  if (!policyFile) problems.push("FOXTRUST_POLICY_FILE is required");

  const trustedProxies: Cidr[] = [];
  for (const item of (text("FOXTRUST_TRUSTED_PROXIES") ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
    const cidr = parseCidr(item);
    if (cidr) trustedProxies.push(cidr);
    else problems.push(`FOXTRUST_TRUSTED_PROXIES: ${item} is not a CIDR`);
  }

  const failMode = text("FOXTRUST_FAIL_MODE") ?? "open";
  if (failMode !== "open" && failMode !== "closed") problems.push("FOXTRUST_FAIL_MODE must be open or closed");

  const challengeUrl = text("FOXTRUST_CHALLENGE_URL");
  const builtIn = challengeUrl?.startsWith("/") ?? false;
  if (challengeUrl && builtIn) {
    const problem = challengePathProblem(challengeUrl);
    if (problem) problems.push(problem);
  } else if (challengeUrl) {
    try {
      const url = new URL(challengeUrl);
      if (url.protocol !== "https:" && url.protocol !== "http:") problems.push("FOXTRUST_CHALLENGE_URL must be http(s)");
    } catch {
      problems.push("FOXTRUST_CHALLENGE_URL is not a URL");
    }
  }
  const challengeFallback = text("FOXTRUST_CHALLENGE_FALLBACK") ?? "allow";
  if (!(ACTIONS as readonly string[]).includes(challengeFallback) || challengeFallback === "challenge") {
    problems.push("FOXTRUST_CHALLENGE_FALLBACK must be allow or block");
  }
  const challengeSecret = text("FOXTRUST_CHALLENGE_SECRET");
  if (challengeSecret && challengeSecret.length < 32) problems.push("FOXTRUST_CHALLENGE_SECRET must be at least 32 characters");
  if (builtIn && !challengeSecret) problems.push("FOXTRUST_CHALLENGE_SECRET is required when FOXTRUST_CHALLENGE_URL is a path (built-in challenge page)");

  const int = (name: string, fallback: number, min: number, max: number) => {
    const raw = text(name);
    const value = raw === null ? fallback : Number(raw);
    if (!Number.isInteger(value) || value < min || value > max) problems.push(`${name} must be a whole number from ${min} to ${max}`);
    return value;
  };
  const difficulty = parseDifficulty(text("FOXTRUST_CHALLENGE_DIFFICULTY"), problems);
  const challengeTtlSeconds = int("FOXTRUST_CHALLENGE_TTL_SECONDS", DEFAULT_CHALLENGE.challengeTtlSeconds, 30, 600);
  const passTtlMinutes = int("FOXTRUST_PASS_TTL_MINUTES", DEFAULT_CHALLENGE.passTtlMinutes, 1, 1440);
  const noJsText = text("FOXTRUST_CHALLENGE_NOJS") ?? "off";
  if (noJsText !== "on" && noJsText !== "off") problems.push("FOXTRUST_CHALLENGE_NOJS must be on or off");
  const waitSeconds = int("FOXTRUST_CHALLENGE_NOJS_WAIT_SECONDS", DEFAULT_CHALLENGE.waitSeconds, 3, 120);
  if (waitSeconds >= challengeTtlSeconds) problems.push("FOXTRUST_CHALLENGE_NOJS_WAIT_SECONDS must be less than FOXTRUST_CHALLENGE_TTL_SECONDS");

  const maxAgeHours = Number(text("FOXTRUST_MAX_AGE_HOURS") ?? "26");
  if (!Number.isFinite(maxAgeHours) || maxAgeHours <= 0) problems.push("FOXTRUST_MAX_AGE_HOURS must be a positive number");
  const updateEvery = text("FOXTRUST_UPDATE_EVERY") ?? "*/5 * * * *";
  if (updateEvery.split(/\s+/).length !== 5) problems.push("FOXTRUST_UPDATE_EVERY must be a 5-field cron expression");
  const port = Number(text("PORT") ?? "8080");
  if (!Number.isInteger(port) || port < 0 || port > 65535) problems.push("PORT must be a port number");

  let scoringConfigFile = text("FOXTRUST_SCORING_CONFIG");
  if (!scoringConfigFile) {
    try {
      scoringConfigFile = defaultScoringConfigFile();
    } catch (error) {
      problems.push((error as Error).message);
    }
  }

  if (problems.length > 0) throw new VerifyConfigError(problems.join("\n"));
  return {
    publicationUrl,
    trustedKeys,
    policyFile: policyFile!,
    scoringConfigFile: scoringConfigFile!,
    trustedProxies,
    failMode: failMode as "open" | "closed",
    challengeUrl,
    challengeFallback: challengeFallback as Action,
    challengeSecret,
    challenge: {
      page: !challengeUrl ? "none" : builtIn ? "built-in" : "external",
      path: builtIn ? challengeUrl : null,
      difficulty,
      challengeTtlSeconds,
      passTtlMinutes,
      noJs: noJsText === "on",
      waitSeconds,
    },
    maxAgeHours,
    updateEvery,
    port,
  };
}
