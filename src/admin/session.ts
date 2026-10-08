import type { SQL } from "bun";
import { timingSafeEqual } from "node:crypto";
import type { Flow } from "./oidc";

/**
 * Operator sessions (spec 011 research R2, R3): a random 256-bit id in the cookie, only its SHA-256
 * in the database; 8 hours, never extended; sign-out deletes the row. The sign-in flow values travel
 * in a short-lived cookie signed with a per-process key, so nothing is stored before sign-in.
 */

export const SESSION_HOURS = 8;
const FLOW_MS = 10 * 60_000;

export type Session = { subject: string; name: string; csrf: string; idToken: string; expiresAt: Date };

const b64url = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");
const random = () => b64url(crypto.getRandomValues(new Uint8Array(32)));
const sha256 = (text: string) => new Bun.CryptoHasher("sha256").update(text).digest();

export function equalText(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Cookie names and attributes: `__Host-` and `Secure` over HTTPS; plain for local HTTP development. */
export function cookieNames(secure: boolean) {
  const attrs = `Path=/; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
  return { session: secure ? "__Host-foxtrust_admin" : "foxtrust_admin", flow: secure ? "__Host-foxtrust_admin_flow" : "foxtrust_admin_flow", attrs };
}

export function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

export function createSessions(sql: SQL, clock: () => Date = () => new Date()) {
  const flowKey = crypto.getRandomValues(new Uint8Array(32));
  const mac = (text: string) => b64url(new Bun.CryptoHasher("sha256", flowKey).update(text).digest());

  return {
    /** A new session; returns the cookie value. Expired sessions are deleted on the way. */
    async create(input: { subject: string; name: string; idToken: string }): Promise<string> {
      const now = clock();
      const id = random();
      await sql`DELETE FROM admin_session WHERE expires_at < ${now}`;
      await sql`
        INSERT INTO admin_session (id_sha256, subject, name, csrf, id_token, created_at, expires_at)
        VALUES (${sha256(id)}, ${input.subject}, ${input.name.slice(0, 200)}, ${random()}, ${input.idToken}, ${now},
                ${new Date(now.getTime() + SESSION_HOURS * 3_600_000)})`;
      return id;
    },

    async find(cookie: string | null): Promise<Session | null> {
      if (!cookie || cookie.length > 64) return null;
      const [row] = (await sql`
        SELECT subject, name, csrf, id_token, expires_at FROM admin_session
        WHERE id_sha256 = ${sha256(cookie)} AND expires_at > ${clock()}`) as { subject: string; name: string; csrf: string; id_token: string; expires_at: Date }[];
      return row ? { subject: row.subject, name: row.name, csrf: row.csrf, idToken: row.id_token, expiresAt: row.expires_at } : null;
    },

    async end(cookie: string | null): Promise<void> {
      if (cookie && cookie.length <= 64) await sql`DELETE FROM admin_session WHERE id_sha256 = ${sha256(cookie)}`;
    },

    /** The signed flow cookie value: the flow, the local return path and an expiry. */
    signFlow(flow: Flow, returnTo: string): string {
      const body = b64url(new TextEncoder().encode(JSON.stringify({ ...flow, returnTo, exp: clock().getTime() + FLOW_MS })));
      return `${body}.${mac(body)}`;
    },

    readFlow(value: string | null): (Flow & { returnTo: string }) | null {
      if (!value || value.length > 2048) return null;
      const [body, sig] = value.split(".");
      if (!body || !sig || !equalText(sig, mac(body))) return null;
      try {
        const v = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Flow & { returnTo: string; exp: number };
        return v.exp > clock().getTime() ? { state: v.state, nonce: v.nonce, verifier: v.verifier, returnTo: v.returnTo } : null;
      } catch {
        return null;
      }
    },
  };
}

export type Sessions = ReturnType<typeof createSessions>;
