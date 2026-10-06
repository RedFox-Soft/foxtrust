import { Elysia } from "elysia";
import { decide, type Decision } from "../decision/engine";
import { formatIp } from "../ip/parse";
import type { Action } from "../policy";
import type { ChallengeAssets } from "./challenge/assets";
import { createReplayCache, type ReplayCache } from "./challenge/replay";
import { challengeRoutePaths, challengeRoutes, PASS_COOKIE, type BotDeps } from "./challenge/routes";
import { clientAddress } from "./client-ip";
import { DEFAULT_CHALLENGE, type ChallengeSettings, type VerifyConfig } from "./config";
import type { Loader } from "./loader";
import type { PolicyHolder } from "./policy-file";
import { verifyPassToken } from "./token";

/**
 * `/verify` forward-auth service (contracts/verify-http.md). Answers from the snapshot held in
 * memory: no database and no network call per request (FR-022).
 */

type ProxyMode = "nginx" | "traefik" | "caddy";
const PROXY_MODES: ProxyMode[] = ["nginx", "traefik", "caddy"];

export type VerifyDeps = {
  loader: Loader;
  policy: PolicyHolder;
  /** Without `challenge`, the defaults apply and the page kind follows `challengeUrl`. */
  config: Pick<VerifyConfig, "trustedProxies" | "failMode" | "challengeUrl" | "challengeFallback" | "challengeSecret"> & {
    challenge?: ChallengeSettings;
  };
  /** Browser scripts of the built-in challenge page; required when the page is built in. */
  challengeAssets?: ChallengeAssets;
  /** Bot verdict of the built-in page (spec 007): its policy, weights, zones and JA4 families. */
  bot?: BotDeps | null;
  /** Accepted challenge nonces (default: a fresh cache with the standard cap). */
  replay?: ReplayCache;
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

/** True when `uri` is exactly one of the built-in page's routes, with an optional query. */
function isChallengeRoute(uri: string, routes: string[]): boolean {
  const q = uri.indexOf("?");
  return routes.includes(q === -1 ? uri : uri.slice(0, q));
}

/** `scheme://host[:port]` of the original request as the proxy reports it, or null. */
function forwardedOrigin(headers: Headers): string | null {
  const host = headers.get("x-forwarded-host");
  const proto = headers.get("x-forwarded-proto");
  // Only a plain host[:port] is used; anything else is left out rather than echoed.
  if (host && /^[A-Za-z0-9.-]+(:\d{1,5})?$|^\[[0-9A-Fa-f:.]+\](:\d{1,5})?$/.test(host)) {
    return `${proto === "http" ? "http" : "https"}://${host}`;
  }
  return null;
}

/** The original URL as the proxy saw it, for the challenge page's return address. */
function originalUrl(headers: Headers): string {
  const uri = headers.get("x-forwarded-uri") ?? headers.get("x-original-uri") ?? "/";
  const path = uri.startsWith("/") ? uri : `/${uri}`;
  return `${forwardedOrigin(headers) ?? ""}${path}`;
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
  const challenge: ChallengeSettings = config.challenge ?? {
    ...DEFAULT_CHALLENGE,
    page: !config.challengeUrl ? "none" : config.challengeUrl.startsWith("/") ? "built-in" : "external",
    path: config.challengeUrl?.startsWith("/") ? config.challengeUrl : null,
  };
  const builtIn = challenge.page === "built-in" && challenge.path !== null;
  const exempt = builtIn ? challengeRoutePaths(challenge.path!) : [];
  if (builtIn && (!config.challengeSecret || !deps.challengeAssets)) {
    throw new Error("the built-in challenge page needs FOXTRUST_CHALLENGE_SECRET and its built scripts");
  }

  const app = new Elysia()
    .get("/healthz", () => {
      const ok = deps.loader.current() !== null || config.failMode === "open";
      return new Response(ok ? "ok\n" : "no snapshot loaded\n", { status: ok ? 200 : 503 });
    })
    .get("/status", () =>
      Response.json(
        {
          ...deps.loader.status(),
          policy: deps.policy.status(),
          challenge: {
            enforced: challenge.page !== "none",
            page: challenge.page,
            path: challenge.path,
            difficulty: challenge.difficulty,
            challengeTtlSeconds: challenge.challengeTtlSeconds,
            passTtlMinutes: challenge.passTtlMinutes,
            noJs: challenge.noJs,
            waitSeconds: challenge.waitSeconds,
          },
          bot: deps.bot
            ? {
                mode: deps.bot.policy.mode, weightsVersion: deps.bot.weights.version, stepUp: deps.bot.policy.stepUp,
                block: deps.bot.policy.block, afterStepUp: deps.bot.policy.afterStepUp, stepUpBits: deps.bot.policy.stepUpBits,
                ja4Families: deps.bot.families.size,
              }
            : { mode: "off" },
        },
        { headers: { "Cache-Control": "no-store" } },
      ))
    .all("/verify", ({ request, server, query }) => {
      const mode = (PROXY_MODES as string[]).includes(String(query.proxy)) ? (query.proxy as ProxyMode) : "traefik";
      const headers = request.headers;
      const uri = headers.get("x-forwarded-uri") ?? headers.get("x-original-uri") ?? "/";
      if (isChallengeRoute(uri, exempt)) {
        // The challenge page itself is never challenged or blocked (spec 006 FR-003): exact routes only.
        return new Response(null, {
          status: 200,
          headers: {
            "X-FoxTrust-Action": "allow", "X-FoxTrust-Rule": "default", "X-FoxTrust-Reason": "challenge-page",
            "X-FoxTrust-Snapshot": deps.loader.source().snapshotVersion ?? "none", "Cache-Control": "no-store",
          },
        });
      }
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
      // A built-in page lives on the protected host: it gets the original path and query, and is
      // addressed on the forwarded host when the proxy names it. Traefik resolves a relative Location
      // against the forward-auth address and nginx against its own listener, so relative is the fallback.
      const returnTo = builtIn ? (uri.startsWith("/") ? uri : `/${uri}`) : originalUrl(headers);
      const base = builtIn ? `${forwardedOrigin(headers) ?? ""}${config.challengeUrl}` : config.challengeUrl!;
      const location = `${base}${base.includes("?") ? "&" : "?"}return=${encodeURIComponent(returnTo)}`;
      if (mode === "nginx") return new Response(null, { status: 401, headers: { ...out, "X-FoxTrust-Challenge-Location": location } });
      return new Response(null, { status: 302, headers: { ...out, Location: location } });
    });

  if (!builtIn) return app;
  return app.use(
    challengeRoutes({
      settings: { ...challenge, path: challenge.path! },
      secret: config.challengeSecret!,
      trustedProxies: config.trustedProxies,
      loader: deps.loader,
      replay: deps.replay ?? createReplayCache(),
      assets: deps.challengeAssets!,
      bot: deps.bot ?? null,
      clock,
      log,
    }),
  );
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
