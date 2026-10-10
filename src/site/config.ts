import { readFileSync } from "node:fs";
import { FREE_TIER, LIMITS, type TierDefaults } from "../api/accounts";

/**
 * Settings of `foxtrust site serve` (spec 012 research R8). Without any sign-in setting the site runs
 * in public-only mode: the public pages need neither the database nor foxauth. The client secret
 * never appears in a message.
 */
export type SiteSignIn = {
  databaseUrl: string;
  issuer: string;
  clientId: string;
  clientSecret: string;
  /** The operator's address shown to disabled accounts. */
  contact: string;
};

export type SiteConfig = {
  /** The site's origin without a trailing slash; `redirect_uri` is built from it. */
  url: string;
  apiUrl: string;
  publicationUrl: string;
  trustedKeys: string[];
  free: TierDefaults;
  maxKeys: number;
  keysPerDay: number;
  port: number;
  signIn: SiteSignIn | null;
};

export class SiteConfigError extends Error {}

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

export function readSiteConfig(env: Record<string, string | undefined> = Bun.env, opts: { allowHttpIssuer?: boolean } = {}): SiteConfig {
  const problems: string[] = [];
  const text = (name: string) => env[name]?.trim() || null;

  const origin = (name: string, fallback: string | null, allowLocalHttp: boolean): string => {
    const value = (text(name) ?? fallback ?? "").replace(/\/+$/, "");
    if (!value) {
      problems.push(`${name} is required`);
      return "";
    }
    try {
      const u = new URL(value);
      const localHttp = u.protocol === "http:" && LOCAL_HOSTS.has(u.hostname);
      if (u.protocol !== "https:" && !(allowLocalHttp && localHttp)) problems.push(`${name} must be https://${allowLocalHttp ? " (http:// only for 127.0.0.1 or localhost)" : ""}`);
      if (u.pathname !== "/" || u.search || u.hash) problems.push(`${name} must be an origin without a path`);
    } catch {
      problems.push(`${name} is not a URL`);
    }
    return value;
  };

  const url = origin("FOXTRUST_SITE_URL", null, true);
  const apiUrl = origin("FOXTRUST_SITE_API_URL", "https://api.foxtrust.dev", true);
  const publicationUrl = origin("FOXTRUST_SITE_PUBLICATION_URL", "https://data.foxtrust.dev", true);

  const trustedKeys = (text("FOXTRUST_TRUSTED_KEYS") ?? "").split(",").map((k) => k.trim()).filter(Boolean);
  for (const key of trustedKeys) {
    if (Buffer.from(key, "base64").length !== 32) problems.push(`FOXTRUST_TRUSTED_KEYS: ${key.slice(0, 12)}… is not a base64 32-byte Ed25519 key`);
  }

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
  const maxKeys = int("FOXTRUST_SITE_MAX_KEYS", 3, 1, 100);
  const keysPerDay = int("FOXTRUST_SITE_KEYS_PER_DAY", 10, 1, 1000);
  const port = int("PORT", 8084, 0, 65535);

  // Sign-in: all of the group, or none of it (public-only mode).
  const secretFile = text("FOXTRUST_SITE_CLIENT_SECRET_FILE");
  const group = { clientId: text("FOXTRUST_SITE_CLIENT_ID"), secret: text("FOXTRUST_SITE_CLIENT_SECRET") ?? secretFile, contact: text("FOXTRUST_SITE_CONTACT") };
  let signIn: SiteSignIn | null = null;
  if (group.clientId || group.secret || group.contact) {
    if (!group.clientId) problems.push("FOXTRUST_SITE_CLIENT_ID is required for sign-in");
    if (!group.contact) problems.push("FOXTRUST_SITE_CONTACT is required for sign-in");
    let clientSecret = text("FOXTRUST_SITE_CLIENT_SECRET") ?? "";
    if (secretFile) {
      try {
        clientSecret = readFileSync(secretFile, "utf8").trim();
      } catch {
        problems.push("FOXTRUST_SITE_CLIENT_SECRET_FILE cannot be read");
      }
    }
    if (!clientSecret) problems.push("FOXTRUST_SITE_CLIENT_SECRET or FOXTRUST_SITE_CLIENT_SECRET_FILE is required for sign-in");
    const databaseUrl = text("DATABASE_URL") ?? "";
    if (!databaseUrl) problems.push("DATABASE_URL is required for sign-in");
    const issuer = (text("FOXTRUST_SITE_ISSUER") ?? "https://auth.foxauth.dev").replace(/\/+$/, "");
    if (!issuer.startsWith("https://") && !(opts.allowHttpIssuer && issuer.startsWith("http://127.0.0.1"))) {
      problems.push("FOXTRUST_SITE_ISSUER must be an https:// URL");
    }
    signIn = { databaseUrl, issuer, clientId: group.clientId ?? "", clientSecret, contact: group.contact ?? "" };
  }

  if (problems.length > 0) throw new SiteConfigError(problems.join("\n"));
  return { url, apiUrl, publicationUrl, trustedKeys, free, maxKeys, keysPerDay, port, signIn };
}
