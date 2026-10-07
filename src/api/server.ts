import { Elysia } from "elysia";
import { formatIp, toIpValue, type IpValue } from "../ip/parse";
import type { Loader } from "../verify/loader";
import type { ActiveKey } from "./accounts";
import { parseKey, secretMatches } from "./key";
import type { KeySet } from "./keyset";
import type { LimitHeaders, Limits } from "./limits";

/**
 * Public API v1 (spec 010 contracts/api-v1.md): `GET /v1/ip/{ip}` answers the customer verdict from
 * the published snapshot held in memory. No database query per lookup. Logs carry per-minute counts
 * by outcome only: never a queried address or a key secret (FR-013, FR-015).
 */

export type ErrorCode = "invalid_ip" | "key_missing" | "key_invalid" | "key_in_query" | "quota_exceeded" | "rate_limited" | "no_data";
type Outcome = "answered" | "invalid" | "limited" | "unauthorized" | "unavailable" | "refused";

const MESSAGES: Record<ErrorCode, string> = {
  invalid_ip: "The path must hold a single IPv4 or IPv6 address.",
  key_missing: "Send your API key in the Authorization header (Bearer) or in X-API-Key.",
  key_invalid: "The API key is not valid.",
  key_in_query: "API keys are not accepted in the URL; send the key in a request header.",
  quota_exceeded: "The daily quota of this key is used; it resets at 00:00 UTC.",
  rate_limited: "Too many requests per second for this key.",
  no_data: "No verdict data is loaded yet; try again shortly.",
};
const STATUS: Record<ErrorCode, number> = {
  invalid_ip: 400, key_in_query: 400, key_missing: 401, key_invalid: 401, quota_exceeded: 429, rate_limited: 429, no_data: 503,
};
const KEY_PARAMS = ["key", "api_key", "apikey"];
const PREFIX = "/v1/ip/";
/** The longest textual IPv6 address with an IPv4 tail. */
const MAX_ADDRESS = 45;
const SUMMARY_MS = 60_000;

const CORS = { "Access-Control-Allow-Origin": "*" };
const BASE_HEADERS = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...CORS };

function rateHeaders(h: LimitHeaders | null): Record<string, string> {
  return h ? { "X-RateLimit-Limit": String(h.limit), "X-RateLimit-Remaining": String(h.remaining), "X-RateLimit-Reset": String(h.reset) } : {};
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...BASE_HEADERS, ...headers } });
}

const failure = (code: ErrorCode, limit: LimitHeaders | null, extra: Record<string, string> = {}) =>
  json(STATUS[code], { error: { code, message: MESSAGES[code] } }, { ...rateHeaders(limit), ...extra });

/** The single address in the path, or null: no CIDR, zone id, whitespace or over-long value. */
function addressOf(rawPath: string): IpValue | null {
  let text: string;
  try {
    text = decodeURIComponent(rawPath);
  } catch {
    return null;
  }
  if (text.length === 0 || text.length > MAX_ADDRESS || /[\s%/]/.test(text)) return null;
  const ip = toIpValue(text);
  return "error" in ip ? null : ip;
}

/** The key presented in a header: missing, malformed or unknown, or the active key. */
function presentedKey(request: Request, keys: KeySet): ActiveKey | "missing" | "invalid" {
  const auth = request.headers.get("authorization");
  const raw = auth !== null ? /^Bearer\s+(\S+)$/i.exec(auth.trim())?.[1] ?? "" : request.headers.get("x-api-key");
  if (raw === null) return "missing";
  const parsed = parseKey(raw.trim());
  if (!parsed) return "invalid";
  const key = keys.find(parsed.id);
  return key && secretMatches(parsed.secret, key.sha256) ? key : "invalid";
}

export type ApiDeps = { loader: Loader; keys: KeySet; limits: Limits; clock?: () => Date; log?: (line: string) => void };

export function createApiApp(deps: ApiDeps) {
  const clock = deps.clock ?? (() => new Date());
  const log = deps.log ?? (() => {});
  const counts: Record<Outcome, number> = { answered: 0, invalid: 0, limited: 0, unauthorized: 0, unavailable: 0, refused: 0 };

  function lookup(request: Request): Response {
    const url = new URL(request.url);
    if (KEY_PARAMS.some((name) => url.searchParams.has(name))) {
      counts.refused++;
      return failure("key_in_query", null);
    }
    const key = presentedKey(request, deps.keys);
    if (key === "missing" || key === "invalid") {
      counts.unauthorized++;
      return failure(key === "missing" ? "key_missing" : "key_invalid", null);
    }
    const limit = deps.limits.check(key);
    if (!limit.ok) {
      counts.limited++;
      return failure(limit.code, deps.limits.record(key, "limited"), { "Retry-After": String(limit.retryAfter) });
    }
    const state = deps.loader.current();
    if (!state) {
      counts.unavailable++;
      return failure("no_data", limit.headers, { "Retry-After": "60" });
    }
    const ip = addressOf(url.pathname.slice(PREFIX.length));
    if (!ip) {
      counts.invalid++;
      return failure("invalid_ip", deps.limits.record(key, "invalid"));
    }
    const verdict = state.lookup(ip);
    const status = deps.loader.status();
    counts.answered++;
    return json(200, {
      ip: formatIp(ip),
      risk: verdict?.risk ?? 0,
      level: verdict?.level ?? "low",
      categories: verdict?.categories ?? [],
      reasons: verdict?.reasons.map((r) => ({ code: r.code, lastSeen: r.lastSeen, contribution: r.contribution })) ?? [],
      network: { asn: verdict?.network.asn ?? null, org: verdict?.network.org ?? null, country: verdict?.network.country ?? null },
      data: {
        version: state.full.version,
        delta: state.delta?.version ?? null,
        builtAt: (state.delta?.builtAt ?? state.full.builtAt).toISOString(),
        stale: status.stale,
      },
      disputeUrl: deps.loader.disputeUrl(),
    }, rateHeaders(deps.limits.record(key, "answered")));
  }

  /** One log line with the counts since the last one; nothing when there was no traffic. */
  function summarize(): string | null {
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    if (total === 0) return null;
    const line = `api: last minute ${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(" ")} keys=${deps.keys.size()}`;
    for (const k of Object.keys(counts) as Outcome[]) counts[k] = 0;
    log(line);
    return line;
  }

  const app = new Elysia()
    .get(`${PREFIX}*`, ({ request }) => lookup(request))
    .options(`${PREFIX}*`, () => new Response(null, {
      status: 204,
      headers: { ...CORS, "Access-Control-Allow-Methods": "GET", "Access-Control-Allow-Headers": "Authorization, X-API-Key", "Access-Control-Max-Age": "86400" },
    }))
    .get("/healthz", () => {
      const ok = deps.loader.current() !== null && deps.keys.loaded();
      return new Response(ok ? "ok\n" : "not ready\n", { status: ok ? 200 : 503 });
    })
    .get("/status", () => {
      const s = deps.loader.status();
      return json(200, {
        snapshotVersion: s.snapshotVersion, deltaVersion: s.deltaVersion, builtAt: s.builtAt, ageSeconds: s.ageSeconds, stale: s.stale,
        keys: deps.keys.status(),
        usage: deps.limits.status(),
      });
    });

  return {
    app,
    summarize,
    /** Writes the per-minute summary whenever a minute has passed on the clock. */
    startSummary: (pollMs = 1000): (() => void) => {
      let last = clock().getTime();
      const timer = setInterval(() => {
        const now = clock().getTime();
        if (now - last >= SUMMARY_MS) {
          last = now;
          summarize();
        }
      }, pollMs);
      return () => clearInterval(timer);
    },
  };
}

export function startApiServer(deps: ApiDeps & { port: number; hostname?: string }) {
  const { app, summarize, startSummary } = createApiApp(deps);
  app.listen({ port: deps.port, hostname: deps.hostname ?? "0.0.0.0" });
  const stopSummary = startSummary();
  return {
    port: app.server!.port as number,
    summarize,
    stop: async () => {
      stopSummary();
      await app.stop();
    },
  };
}
