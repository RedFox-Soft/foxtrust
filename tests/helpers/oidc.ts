import { createHmac, generateKeyPairSync, sign, type KeyObject } from "node:crypto";

/**
 * A fake OIDC provider shaped like foxauth's discovery (RS256 only, PKCE S256, `iss` in the
 * authorization response, `groups` claim or a distributed claim through userinfo). Tests never call
 * the live foxauth (constitution Principle V). Codes are single-use.
 */

export type FakeUser = { sub: string; name?: string; email?: string; groups?: string[]; distributed?: boolean };
export type Forge = { alg?: "HS256" | "none"; aud?: string; iss?: string; expired?: boolean; nonce?: string; otherKey?: boolean };

export type FakeOidc = {
  issuer: string;
  clientId: string;
  clientSecret: string;
  /** The user the next `/auth` signs in. */
  nextUser: (user: FakeUser) => void;
  /** Makes the next ID token wrong in one way. */
  forge: (f: Forge) => void;
  /** The next authorization response carries a wrong `iss` parameter. */
  wrongIss: () => void;
  goOffline: () => void;
  goOnline: () => void;
  /** ID tokens issued so far (to check none leaks). */
  issued: string[];
  stop: () => Promise<void>;
};

const b64url = (v: Uint8Array | string) => Buffer.from(v).toString("base64url");

export function startFakeOidc(opts: { clientId?: string; clientSecret?: string } = {}): Promise<FakeOidc> {
  const clientId = opts.clientId ?? "foxtrust-admin-test";
  const clientSecret = opts.clientSecret ?? `test-secret-${crypto.randomUUID()}`;
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const other = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
  const kid = "test-key-1";
  const jwk = { ...(publicKey.export({ format: "jwk" }) as object), kid, use: "sig", alg: "RS256" };

  let user: FakeUser = { sub: "operator-1", name: "Test Operator", groups: ["foxtrust-operators"] };
  let forged: Forge | null = null;
  let badIss = false;
  let offline = false;
  const issued: string[] = [];
  const codes = new Map<string, { user: FakeUser; nonce: string; challenge: string; redirectUri: string; used: boolean }>();
  const tokens = new Map<string, FakeUser>();

  const jws = (header: object, payload: object, key: KeyObject | null, alg: string) => {
    const h = b64url(JSON.stringify(header));
    const p = b64url(JSON.stringify(payload));
    const input = `${h}.${p}`;
    const sig = alg === "none" ? "" : alg === "HS256" ? b64url(createHmac("sha256", clientSecret).update(input).digest()) : b64url(sign("RSA-SHA256", Buffer.from(input), key!));
    return `${input}.${sig}`;
  };

  let issuer = "";
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      if (offline) return new Response("unavailable", { status: 503 });
      const url = new URL(request.url);
      switch (url.pathname) {
        case "/.well-known/openid-configuration":
          return Response.json({
            issuer, authorization_endpoint: `${issuer}/auth`, token_endpoint: `${issuer}/token`, userinfo_endpoint: `${issuer}/userinfo`,
            jwks_uri: `${issuer}/jwks`, end_session_endpoint: `${issuer}/logout`, scopes_supported: ["openid", "profile", "email", "groups"],
            id_token_signing_alg_values_supported: ["RS256"], token_endpoint_auth_methods_supported: ["client_secret_basic"],
            code_challenge_methods_supported: ["S256"], response_types_supported: ["code"], authorization_response_iss_parameter_supported: true,
          });
        case "/jwks":
          return Response.json({ keys: [jwk] });
        case "/auth": {
          const q = url.searchParams;
          if (q.get("client_id") !== clientId || q.get("response_type") !== "code" || q.get("code_challenge_method") !== "S256") {
            return new Response("bad authorization request", { status: 400 });
          }
          const scopes = (q.get("scope") ?? "").split(" ");
          if (!scopes.includes("openid") || !scopes.includes("groups")) return new Response("scope must include openid and groups", { status: 400 });
          const code = b64url(crypto.getRandomValues(new Uint8Array(24)));
          codes.set(code, { user, nonce: q.get("nonce") ?? "", challenge: q.get("code_challenge") ?? "", redirectUri: q.get("redirect_uri") ?? "", used: false });
          const back = new URL(q.get("redirect_uri")!);
          back.searchParams.set("code", code);
          back.searchParams.set("state", q.get("state") ?? "");
          back.searchParams.set("iss", badIss ? "https://evil.example" : issuer);
          badIss = false;
          return new Response(null, { status: 302, headers: { Location: back.toString() } });
        }
        case "/token": {
          const basic = `Basic ${Buffer.from(`${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`).toString("base64")}`;
          if (request.headers.get("authorization") !== basic) return Response.json({ error: "invalid_client" }, { status: 401 });
          const form = new URLSearchParams(await request.text());
          const entry = codes.get(form.get("code") ?? "");
          if (!entry || entry.used) return Response.json({ error: "invalid_grant" }, { status: 400 });
          entry.used = true;
          const verifier = form.get("code_verifier") ?? "";
          const challenge = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
          if (challenge !== entry.challenge || form.get("redirect_uri") !== entry.redirectUri) return Response.json({ error: "invalid_grant" }, { status: 400 });
          const now = Math.floor(Date.now() / 1000);
          const f = forged ?? {};
          forged = null;
          const claims: Record<string, unknown> = {
            iss: f.iss ?? issuer, sub: entry.user.sub, aud: f.aud ?? clientId, iat: now, exp: f.expired ? now - 600 : now + 300,
            nonce: f.nonce ?? entry.nonce, ...(entry.user.name ? { name: entry.user.name } : {}), ...(entry.user.email ? { email: entry.user.email } : {}),
          };
          if (entry.user.distributed) {
            claims._claim_names = { groups: "src1" };
            claims._claim_sources = { src1: { endpoint: `${issuer}/userinfo` } };
          } else if (entry.user.groups) claims.groups = entry.user.groups;
          const alg = f.alg ?? "RS256";
          const idToken = jws({ alg, kid, typ: "JWT" }, claims, f.otherKey ? other : privateKey, alg);
          issued.push(idToken);
          const accessToken = b64url(crypto.getRandomValues(new Uint8Array(24)));
          tokens.set(accessToken, entry.user);
          return Response.json({ access_token: accessToken, token_type: "Bearer", expires_in: 300, id_token: idToken });
        }
        case "/userinfo": {
          const u = tokens.get((request.headers.get("authorization") ?? "").replace(/^Bearer /, ""));
          if (!u) return new Response("unauthorized", { status: 401 });
          return Response.json({ sub: u.sub, ...(u.groups ? { groups: u.groups } : {}) });
        }
        case "/logout":
          return new Response("signed out", { status: 200 });
        default:
          return new Response("not found", { status: 404 });
      }
    },
  });
  issuer = `http://127.0.0.1:${server.port}`;
  return Promise.resolve({
    issuer, clientId, clientSecret, issued,
    nextUser: (u) => {
      user = u;
    },
    forge: (f) => {
      forged = f;
    },
    wrongIss: () => {
      badIss = true;
    },
    goOffline: () => {
      offline = true;
    },
    goOnline: () => {
      offline = false;
    },
    stop: async () => {
      await server.stop(true);
    },
  });
}
