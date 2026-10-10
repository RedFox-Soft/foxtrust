import { createPublicKey, verify, type KeyObject } from "node:crypto";

/**
 * OIDC sign-in with foxauth for the admin panel and the site (spec 011 research R1, spec 012 R1):
 * authorization code flow with PKCE (S256), a confidential client (`client_secret_basic`), and the
 * ID token checks of OIDC Core 3.1.3.7 plus RFC 9207 (`iss` in the authorization response). No
 * dependency: `node:crypto` verifies RS256 signatures. Groups come from the `groups` claim, or from
 * userinfo when foxauth sends a distributed claim (above 200 groups). Email and `email_verified`
 * come from the ID token, or from userinfo when the token lacks them.
 */

/** A failed sign-in. `reason` is for the operator log; the visitor only sees "sign-in failed". */
export class OidcError extends Error {
  constructor(readonly reason: string) {
    super(`sign-in failed: ${reason}`);
  }
}
/** The provider answered, but it is not the configured issuer: a configuration error, not retried. */
export class OidcConfigError extends Error {}

export type Discovery = {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  userinfo_endpoint?: string;
  end_session_endpoint?: string;
  authorization_response_iss_parameter_supported?: boolean;
};

export type Flow = { state: string; nonce: string; verifier: string };
export type SignedIn = { subject: string; name: string; email: string; emailVerified: boolean; groups: string[]; idToken: string };

const SKEW_S = 60;
const RETRY_MS = 30_000;
const TIMEOUT_MS = 10_000;
const MAX_TOKEN = 8192;

const b64url = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");
const random = () => b64url(crypto.getRandomValues(new Uint8Array(32)));
const decodeJson = (part: string): Record<string, unknown> => {
  const value = JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as unknown;
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new OidcError("token part is not an object");
  return value as Record<string, unknown>;
};

export function createOidc(opts: {
  issuer: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  scope?: string;
  fetch?: typeof fetch;
  clock?: () => Date;
}) {
  const doFetch = opts.fetch ?? fetch;
  const clock = opts.clock ?? (() => new Date());
  const scope = opts.scope ?? "openid profile email groups";
  let discovery: Discovery | null = null;
  let failure: { at: number; error: Error } | null = null;
  let keys = new Map<string, KeyObject>();

  async function getJson(url: string, init: RequestInit = {}): Promise<Record<string, unknown>> {
    const res = await doFetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) throw new OidcError(`${new URL(url).pathname} answered ${res.status}`);
    return (await res.json()) as Record<string, unknown>;
  }

  async function loadKeys(d: Discovery) {
    const jwks = await getJson(d.jwks_uri);
    const next = new Map<string, KeyObject>();
    type Jwk = { kty?: string; kid?: string; use?: string; n?: string; e?: string };
    for (const k of Array.isArray(jwks.keys) ? (jwks.keys as Jwk[]) : []) {
      if (k.kty !== "RSA" || !k.kid || (k.use && k.use !== "sig")) continue;
      if (!k.n || !k.e) continue;
      next.set(k.kid, createPublicKey({ key: { kty: "RSA", n: k.n, e: k.e }, format: "jwk" }));
    }
    keys = next;
  }

  /** Discovery, read once; a failure is remembered for 30 s and then retried. */
  async function ready(): Promise<Discovery> {
    if (discovery) return discovery;
    if (failure && Date.now() - failure.at < RETRY_MS) throw failure.error;
    try {
      const d = (await getJson(`${opts.issuer}/.well-known/openid-configuration`)) as unknown as Discovery;
      if (d.issuer !== opts.issuer) throw new OidcConfigError(`the provider names issuer ${String(d.issuer)}, not ${opts.issuer}`);
      for (const field of ["authorization_endpoint", "token_endpoint", "jwks_uri"] as const) {
        if (typeof d[field] !== "string") throw new OidcError(`discovery has no ${field}`);
      }
      await loadKeys(d);
      discovery = d;
      failure = null;
      return d;
    } catch (error) {
      if (error instanceof OidcConfigError) throw error;
      failure = { at: Date.now(), error: error instanceof OidcError ? error : new OidcError(`provider unreachable: ${(error as Error).message}`) };
      throw failure.error;
    }
  }

  async function keyFor(kid: string, d: Discovery): Promise<KeyObject> {
    let key = keys.get(kid);
    if (!key) {
      // Keys rotate: one refetch for an unknown kid.
      await loadKeys(d);
      key = keys.get(kid);
    }
    if (!key) throw new OidcError(`no signing key ${kid}`);
    return key;
  }

  async function verifyIdToken(idToken: string, nonce: string, d: Discovery): Promise<Record<string, unknown>> {
    if (idToken.length > MAX_TOKEN) throw new OidcError("ID token too long");
    const parts = idToken.split(".");
    if (parts.length !== 3) throw new OidcError("ID token is not a JWS");
    const [h, p, s] = parts as [string, string, string];
    const header = decodeJson(h);
    if (header.alg !== "RS256") throw new OidcError(`ID token alg ${String(header.alg)} refused`);
    if (typeof header.kid !== "string") throw new OidcError("ID token has no kid");
    const key = await keyFor(header.kid, d);
    const ok = verify("RSA-SHA256", Buffer.from(`${h}.${p}`), key, Buffer.from(s, "base64url"));
    if (!ok) throw new OidcError("ID token signature is invalid");
    const claims = decodeJson(p);
    const now = Math.floor(clock().getTime() / 1000);
    if (claims.iss !== opts.issuer) throw new OidcError("ID token iss mismatch");
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!aud.includes(opts.clientId)) throw new OidcError("ID token aud mismatch");
    if (aud.length > 1 && claims.azp !== opts.clientId) throw new OidcError("ID token azp mismatch");
    if (typeof claims.exp !== "number" || claims.exp + SKEW_S < now) throw new OidcError("ID token expired");
    if (typeof claims.iat !== "number" || claims.iat - SKEW_S > now) throw new OidcError("ID token issued in the future");
    if (claims.nonce !== nonce) throw new OidcError("ID token nonce mismatch");
    if (typeof claims.sub !== "string" || claims.sub.length === 0 || claims.sub.length > 255) throw new OidcError("ID token sub is invalid");
    return claims;
  }

  /** Email and its verification: from the ID token, else from userinfo; an unreadable userinfo means none. */
  async function emailOf(claims: Record<string, unknown>, accessToken: string | null, d: Discovery): Promise<{ email: string; emailVerified: boolean }> {
    let source = claims;
    if (typeof claims.email !== "string" && accessToken && d.userinfo_endpoint) {
      const info = await getJson(d.userinfo_endpoint, { headers: { Authorization: `Bearer ${accessToken}` } }).catch(() => null);
      if (info && (info.sub === undefined || info.sub === claims.sub)) source = info;
    }
    const email = typeof source.email === "string" ? source.email.trim().slice(0, 320) : "";
    return { email, emailVerified: email !== "" && source.email_verified === true };
  }

  async function groupsOf(claims: Record<string, unknown>, accessToken: string | null, d: Discovery): Promise<string[]> {
    if (Array.isArray(claims.groups)) return claims.groups.filter((g): g is string => typeof g === "string");
    const names = claims._claim_names as Record<string, unknown> | undefined;
    if (!names || typeof names.groups !== "string") return [];
    // Distributed claim (foxauth above 200 groups): read the list from userinfo.
    const sources = claims._claim_sources as Record<string, { endpoint?: string; access_token?: string }> | undefined;
    const source = sources?.[names.groups];
    const endpoint = source?.endpoint ?? d.userinfo_endpoint;
    const token = source?.access_token ?? accessToken;
    if (!endpoint || !token) throw new OidcError("distributed groups claim cannot be resolved");
    const info = await getJson(endpoint, { headers: { Authorization: `Bearer ${token}` } });
    if (info.sub !== undefined && info.sub !== claims.sub) throw new OidcError("userinfo sub mismatch");
    return Array.isArray(info.groups) ? info.groups.filter((g): g is string => typeof g === "string") : [];
  }

  return {
    ready,

    /** The authorization URL and the values the callback must check. */
    async authorizationUrl(): Promise<{ url: string; flow: Flow }> {
      const d = await ready();
      const flow: Flow = { state: random(), nonce: random(), verifier: random() };
      const challenge = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(flow.verifier))));
      const url = new URL(d.authorization_endpoint);
      for (const [k, v] of Object.entries({
        response_type: "code", client_id: opts.clientId, redirect_uri: opts.redirectUri, scope,
        state: flow.state, nonce: flow.nonce, code_challenge: challenge, code_challenge_method: "S256",
      })) url.searchParams.set(k, v);
      return { url: url.toString(), flow };
    },

    /** Checks the callback, exchanges the code and verifies the ID token. Throws OidcError on any failure. */
    async finish(query: URLSearchParams, flow: Flow): Promise<SignedIn> {
      const d = await ready();
      if (query.get("error")) throw new OidcError(`provider error ${query.get("error")}`);
      if (!query.get("state") || query.get("state") !== flow.state) throw new OidcError("state mismatch");
      const iss = query.get("iss");
      if (iss !== null ? iss !== opts.issuer : d.authorization_response_iss_parameter_supported === true) throw new OidcError("iss parameter mismatch");
      const code = query.get("code");
      if (!code) throw new OidcError("no code");

      const basic = Buffer.from(`${encodeURIComponent(opts.clientId)}:${encodeURIComponent(opts.clientSecret)}`).toString("base64");
      let tokens: Record<string, unknown>;
      try {
        tokens = await getJson(d.token_endpoint, {
          method: "POST",
          headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
          body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: opts.redirectUri, code_verifier: flow.verifier }).toString(),
        });
      } catch (error) {
        throw error instanceof OidcError ? error : new OidcError(`token endpoint: ${(error as Error).message}`);
      }
      if (typeof tokens.id_token !== "string") throw new OidcError("no ID token");
      const claims = await verifyIdToken(tokens.id_token, flow.nonce, d);
      const accessToken = typeof tokens.access_token === "string" ? tokens.access_token : null;
      const groups = await groupsOf(claims, accessToken, d);
      const { email, emailVerified } = await emailOf(claims, accessToken, d);
      const pick = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 200) : null);
      return {
        subject: claims.sub as string,
        name: pick(claims.name) ?? pick(claims.preferred_username) ?? pick(email) ?? (claims.sub as string).slice(0, 200),
        email,
        emailVerified,
        groups,
        idToken: tokens.id_token,
      };
    },

    /** foxauth's sign-out URL, or null when the provider has none. */
    async endSessionUrl(idToken: string, postLogoutRedirectUri: string): Promise<string | null> {
      const d = await ready().catch(() => null);
      if (!d?.end_session_endpoint) return null;
      const url = new URL(d.end_session_endpoint);
      url.searchParams.set("id_token_hint", idToken);
      url.searchParams.set("post_logout_redirect_uri", postLogoutRedirectUri);
      return url.toString();
    },
  };
}

export type Oidc = ReturnType<typeof createOidc>;
