import { readFileSync } from "node:fs";
import { FREE_TIER, LIMITS, type TierDefaults } from "../api/accounts";

/** Settings of `foxtrust admin serve` (spec 011 data-model.md). The client secret never appears in a message. */
export type AdminConfig = {
  databaseUrl: string;
  /** The panel's base URL without a trailing slash; `redirect_uri` is built from it. */
  url: string;
  issuer: string;
  clientId: string;
  clientSecret: string;
  group: string;
  free: TierDefaults;
  port: number;
};

export class AdminConfigError extends Error {}

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

export function readAdminConfig(env: Record<string, string | undefined> = Bun.env): AdminConfig {
  const problems: string[] = [];
  const text = (name: string) => env[name]?.trim() || null;

  const databaseUrl = text("DATABASE_URL") ?? "";
  if (!databaseUrl) problems.push("DATABASE_URL is required");

  const url = (text("FOXTRUST_ADMIN_URL") ?? "").replace(/\/+$/, "");
  if (!url) problems.push("FOXTRUST_ADMIN_URL is required");
  else {
    try {
      const u = new URL(url);
      if (u.protocol === "http:" && !LOCAL_HOSTS.has(u.hostname)) problems.push("FOXTRUST_ADMIN_URL must be https:// (http:// only for 127.0.0.1 or localhost)");
      else if (u.protocol !== "https:" && u.protocol !== "http:") problems.push("FOXTRUST_ADMIN_URL must be https://");
      if (u.pathname !== "/" || u.search || u.hash) problems.push("FOXTRUST_ADMIN_URL must be an origin without a path");
    } catch {
      problems.push("FOXTRUST_ADMIN_URL is not a URL");
    }
  }

  const issuer = (text("FOXTRUST_ADMIN_ISSUER") ?? "").replace(/\/+$/, "");
  if (!issuer) problems.push("FOXTRUST_ADMIN_ISSUER is required");
  else if (!issuer.startsWith("https://")) problems.push("FOXTRUST_ADMIN_ISSUER must be an https:// URL");

  const clientId = text("FOXTRUST_ADMIN_CLIENT_ID") ?? "";
  if (!clientId) problems.push("FOXTRUST_ADMIN_CLIENT_ID is required");

  let clientSecret = text("FOXTRUST_ADMIN_CLIENT_SECRET") ?? "";
  const secretFile = text("FOXTRUST_ADMIN_CLIENT_SECRET_FILE");
  if (secretFile) {
    try {
      clientSecret = readFileSync(secretFile, "utf8").trim();
    } catch {
      problems.push("FOXTRUST_ADMIN_CLIENT_SECRET_FILE cannot be read");
    }
  }
  if (!clientSecret) problems.push("FOXTRUST_ADMIN_CLIENT_SECRET or FOXTRUST_ADMIN_CLIENT_SECRET_FILE is required");

  const group = text("FOXTRUST_ADMIN_GROUP") ?? "foxtrust-operators";
  if (group.length > 200) problems.push("FOXTRUST_ADMIN_GROUP must be at most 200 characters");

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
  const port = int("PORT", 8083, 0, 65535);

  if (problems.length > 0) throw new AdminConfigError(problems.join("\n"));
  return { databaseUrl, url, issuer, clientId, clientSecret, group, free, port };
}
