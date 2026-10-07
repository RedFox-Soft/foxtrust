import { FREE_TIER, LIMITS, type TierDefaults } from "./accounts";

/** Settings of `foxtrust api serve` (spec 010 contracts/api-v1.md). */
export type ApiConfig = {
  databaseUrl: string;
  publicationUrl: string;
  trustedKeys: string[];
  maxAgeHours: number;
  updateEvery: string;
  free: TierDefaults;
  port: number;
};

export class ApiConfigError extends Error {}

export function readApiConfig(env: Record<string, string | undefined> = Bun.env): ApiConfig {
  const problems: string[] = [];
  const text = (name: string) => env[name]?.trim() || null;

  const databaseUrl = text("DATABASE_URL") ?? "";
  if (!databaseUrl) problems.push("DATABASE_URL is required");

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

  const maxAgeHours = Number(text("FOXTRUST_MAX_AGE_HOURS") ?? "26");
  if (!Number.isFinite(maxAgeHours) || maxAgeHours <= 0) problems.push("FOXTRUST_MAX_AGE_HOURS must be a positive number");
  const updateEvery = text("FOXTRUST_UPDATE_EVERY") ?? "*/5 * * * *";
  if (updateEvery.split(/\s+/).length !== 5) problems.push("FOXTRUST_UPDATE_EVERY must be a 5-field cron expression");

  const int = (name: string, fallback: number, min: number, max: number) => {
    const raw = text(name);
    const value = raw === null ? fallback : Number(raw);
    if (!Number.isInteger(value) || value < min || value > max) problems.push(`${name} must be a whole number from ${min} to ${max}`);
    return value;
  };
  const free = {
    dailyQuota: int("FOXTRUST_API_FREE_DAILY", FREE_TIER.dailyQuota, LIMITS.dailyQuota.min, LIMITS.dailyQuota.max),
    burst: int("FOXTRUST_API_FREE_BURST", FREE_TIER.burst, LIMITS.burst.min, LIMITS.burst.max),
  };
  const port = int("PORT", 8082, 0, 65535);

  if (problems.length > 0) throw new ApiConfigError(problems.join("\n"));
  return { databaseUrl, publicationUrl, trustedKeys, maxAgeHours, updateEvery, free, port };
}
