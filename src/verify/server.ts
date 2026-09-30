import { Elysia } from "elysia";
import { decide, type Decision } from "../decision/engine";
import { formatIp } from "../ip/parse";
import type { Action } from "../policy";
import { clientAddress } from "./client-ip";
import type { VerifyConfig } from "./config";
import type { Loader } from "./loader";
import type { PolicyHolder } from "./policy-file";
import { verifyPassToken } from "./token";

/**
 * `/verify` forward-auth service (contracts/verify-http.md). Answers from the snapshot held in
 * memory: no database and no network call per request (FR-022).
 */

type ProxyMode = "nginx" | "traefik" | "caddy";
const PROXY_MODES: ProxyMode[] = ["nginx", "traefik", "caddy"];
const PASS_COOKIE = "foxtrust_pass";

export type VerifyDeps = {
  loader: Loader;
  policy: PolicyHolder;
  config: Pick<VerifyConfig, "trustedProxies" | "failMode" | "challengeUrl" | "challengeFallback" | "challengeSecret">;
  log?: (line: string) => void;
  clock?: () => Date;
};

const STATUS: Record<Action, number> = { allow: 200, block: 403, challenge: 302 };

function cookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

/** The original URL as the proxy saw it, for the challenge page's return address. */
function originalUrl(headers: Headers): string {
  const uri = headers.get("x-forwarded-uri") ?? headers.get("x-original-uri") ?? "/";
  const path = uri.startsWith("/") ? uri : `/${uri}`;
  const host = headers.get("x-forwarded-host");
  const proto = headers.get("x-forwarded-proto");
  // Only a plain host[:port] is used; anything else is left out rather than echoed.
  if (host && /^[A-Za-z0-9.-]+(:\d{1,5})?$|^\[[0-9A-Fa-f:.]+\](:\d{1,5})?$/.test(host)) {
    return `${proto === "http" ? "http" : "https"}://${host}${path}`;
  }
  return path;
}

function headersFor(decision: Decision): Record<string, string> {
  const headers: Record<string, string> = {
    "X-FoxTrust-Action": decision.action,
    "X-FoxTrust-Rule": decision.rule ?? "default",
    "X-FoxTrust-Reason": decision.reason,
    "X-FoxTrust-Snapshot": decision.snapshotVersion ?? "none",
    "Cache-Control": "no-store",
  };
  if (decision.verdict) {
    headers["X-FoxTrust-Risk"] = String(decision.verdict.risk);
    headers["X-FoxTrust-Level"] = decision.verdict.level;
  }
  if (decision.snapshotVersion === null) headers["X-FoxTrust-No-Data"] = "1";
  return headers;
}

export function createVerifyApp(deps: VerifyDeps) {
  const log = deps.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  const clock = deps.clock ?? (() => new Date());
  const { config } = deps;

  return new Elysia()
    .get("/healthz", () => {
      const ok = deps.loader.current() !== null || config.failMode === "open";
      return new Response(ok ? "ok\n" : "no snapshot loaded\n", { status: ok ? 200 : 503 });
    })
    .get("/status", () => Response.json({ ...deps.loader.status(), policy: deps.policy.status() }, { headers: { "Cache-Control": "no-store" } }))
    .all("/verify", ({ request, server, query }) => {
      const mode = (PROXY_MODES as string[]).includes(String(query.proxy)) ? (query.proxy as ProxyMode) : "traefik";
      const headers = request.headers;
      const peer = server?.requestIP(request)?.address ?? null;
      const ip = clientAddress(peer, headers.get("x-forwarded-for"), config.trustedProxies);
      const policy = deps.policy.current();
      if (!ip || !policy) {
        // No usable client address or no policy: nothing to decide on; the fail mode applies.
        const action: Action = config.failMode === "open" ? "allow" : "block";
        log(`verify: ${action} (${!ip ? "no client address" : "no policy loaded"})`);
        return new Response(null, {
          status: STATUS[action],
          headers: { "X-FoxTrust-Action": action, "X-FoxTrust-Rule": "default", "X-FoxTrust-Reason": "no-data", "X-FoxTrust-Snapshot": "none", "X-FoxTrust-No-Data": "1" },
        });
      }

      const method = (headers.get("x-forwarded-method") ?? headers.get("x-original-method") ?? "GET").toUpperCase();
      const uri = headers.get("x-forwarded-uri") ?? headers.get("x-original-uri") ?? "/";
      const now = clock();
      const token = cookie(headers.get("cookie"), PASS_COOKIE) ?? headers.get("x-foxtrust-pass");
      const decision = decide({
        source: deps.loader.source(),
        policy,
        ip,
        path: uri,
        method,
        passed: verifyPassToken(token, ip, config.challengeSecret, now),
        config: { failMode: config.failMode, challengeUrl: config.challengeUrl, challengeFallback: config.challengeFallback },
        now,
      });

      const out = headersFor(decision);
      if (decision.reason === "challenge-fallback") {
        log(`verify: challenge not enforced (no FOXTRUST_CHALLENGE_URL): ${decision.action} ${formatIp(ip)} rule=${decision.rule} snapshot=${decision.snapshotVersion}`);
      } else if (decision.action !== "allow") {
        log(`verify: ${decision.action} ${formatIp(ip)} rule=${decision.rule ?? "default"} snapshot=${decision.snapshotVersion ?? "none"}`);
      }

      if (decision.action !== "challenge") return new Response(null, { status: STATUS[decision.action], headers: out });
      const location = `${config.challengeUrl}${config.challengeUrl!.includes("?") ? "&" : "?"}return=${encodeURIComponent(originalUrl(headers))}`;
      if (mode === "nginx") return new Response(null, { status: 401, headers: { ...out, "X-FoxTrust-Challenge-Location": location } });
      return new Response(null, { status: 302, headers: { ...out, Location: location } });
    });
}

export function startVerifyServer(deps: VerifyDeps & { port: number; hostname?: string }) {
  const app = createVerifyApp(deps);
  app.listen({ port: deps.port, hostname: deps.hostname ?? "0.0.0.0" });
  return {
    port: app.server!.port as number,
    stop: async () => {
      await app.stop();
    },
  };
}
