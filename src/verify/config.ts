import { join } from "node:path";
import { parseCidr, type Cidr } from "../ip/cidr";
import type { Action } from "../policy";

/** `/verify` configuration from the environment (contracts/verify-http.md). */

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
  if (challengeUrl) {
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
    maxAgeHours,
    updateEvery,
    port,
  };
}
