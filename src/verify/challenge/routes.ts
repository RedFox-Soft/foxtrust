import { Elysia } from "elysia";
import { contains, type Cidr } from "../../ip/cidr";
import { formatIp, type IpValue } from "../../ip/parse";
import { collectEvidence } from "../bot/evidence";
import type { Ja4Families } from "../bot/ja4";
import { decideAction, type BotAction, type BotPolicy } from "../bot/policy";
import { parseProbe } from "../bot/probe-schema";
import { formatReasons, scoreVerdict, type BotVerdict } from "../bot/verdict";
import type { Weights } from "../bot/weights";
import type { Zones } from "../bot/zones";
import { clientAddress } from "../client-ip";
import type { ChallengeSettings, DifficultyKey } from "../config";
import type { Loader } from "../loader";
import { b64url, issuePassTokenV2 } from "../token";
import type { ChallengeAssets } from "./assets";
import { checkAnswer, issueChallenge, readChallenge, type AnswerResult } from "./challenge";
import { COMMON_HEADERS, pageHeaders, renderBlocked, renderChallengePage, renderMalformed, renderWaitPage } from "./page";
import type { ReplayCache } from "./replay";
import { sanitizeReturn } from "./return-url";

/**
 * Routes of the built-in challenge page (spec 006 contracts/challenge-http.md), served by
 * `verify` on a path of each protected host that the operator's proxy routes to it. A correct
 * answer is judged by the bot verdict (spec 007 contracts/bot-verdict.md) unless it is off.
 */

export const PASS_COOKIE = "foxtrust_pass";
export const MAX_ANSWER_BYTES = 8192;
const MAX_BITS = 24;

/** What the bot verdict needs, loaded once at start. */
export type BotDeps = { policy: BotPolicy; weights: Weights; zones: Zones; families: Ja4Families };

export type ChallengeRouteDeps = {
  settings: ChallengeSettings & { path: string };
  secret: string;
  trustedProxies: Cidr[];
  loader: Pick<Loader, "source" | "disputeUrl">;
  replay: ReplayCache;
  assets: ChallengeAssets;
  bot: BotDeps | null;
  clock: () => Date;
  log: (line: string) => void;
};

/** The exact routes under the page path; `/verify` exempts only these from the policy (FR-003). */
export function challengeRoutePaths(path: string): string[] {
  return [path, `${path}/wait`, `${path}/page.js`, `${path}/worker.js`];
}

/** Reads at most `limit` bytes of the body; null when it is larger. */
async function readBody(request: Request, limit: number): Promise<string | null> {
  const declared = request.headers.get("content-length");
  if (declared !== null && (!/^\d{1,10}$/.test(declared) || Number(declared) > limit)) return null;
  if (!request.body) return "";
  const reader = (request.body as ReadableStream<Uint8Array>).getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

type Client = { ip: IpValue | null; host: string | null; plainHttp: boolean; https: boolean; viaProxy: boolean };

export function challengeRoutes(deps: ChallengeRouteDeps) {
  const { settings, secret, log } = deps;
  const { path } = settings;
  const botOn = deps.bot !== null && deps.bot.policy.mode !== "off";

  /** Client address, host and protocol, trusting forwarded headers only from trusted proxies. */
  function client(request: Request, peerAddress: string | null): Client {
    const headers = request.headers;
    const ip = clientAddress(peerAddress, headers.get("x-forwarded-for"), deps.trustedProxies);
    const peer = peerAddress === null ? null : clientAddress(peerAddress, null, []);
    const viaProxy = peer !== null && deps.trustedProxies.some((cidr) => contains(cidr, peer));
    const host = (viaProxy ? headers.get("x-forwarded-host") : null) ?? headers.get("host");
    const forwardedProto = viaProxy ? headers.get("x-forwarded-proto")?.trim().toLowerCase() : undefined;
    const plainHttp = forwardedProto === "http";
    const https = forwardedProto ? forwardedProto === "https" : new URL(request.url).protocol === "https:";
    return { ip, host, plainHttp, https, viaProxy };
  }

  function verdictOf(ip: IpValue) {
    const source = deps.loader.source();
    return source.snapshotVersion === null ? null : source.lookup(ip);
  }

  function bitsFor(ip: IpValue): number {
    const key: DifficultyKey = verdictOf(ip)?.level ?? "none";
    return settings.difficulty[key];
  }

  function page(ip: IpValue, returnTo: string, stepUp = false): Response {
    const now = deps.clock();
    const extra = stepUp && deps.bot ? deps.bot.policy.stepUpBits : 0;
    const bits = Math.min(MAX_BITS, bitsFor(ip) + extra);
    const challenge = issueChallenge({ kind: "pow", ip, bits, ttlSeconds: settings.challengeTtlSeconds, stepUp, secret, now });
    const wait = settings.noJs
      ? {
          challenge: issueChallenge({
            kind: "wait", ip, bits: 0, ttlSeconds: settings.challengeTtlSeconds, waitSeconds: settings.waitSeconds, stepUp, secret, now,
          }),
          seconds: settings.waitSeconds,
        }
      : null;
    const html = renderChallengePage({ path, challenge, nonce: b64url(readChallenge(challenge)!.nonce), bits, returnTo, wait });
    return new Response(html, { status: 200, headers: pageHeaders() });
  }

  const malformed = () => new Response(renderMalformed(), { status: 400, headers: pageHeaders() });

  function passResponse(ip: IpValue, returnTo: string, plainHttp: boolean): Response {
    const token = issuePassTokenV2(ip, settings.passTtlMinutes * 60, secret, deps.clock());
    const cookie = `${PASS_COOKIE}=${token}; Path=/; Max-Age=${settings.passTtlMinutes * 60}; HttpOnly; SameSite=Lax${plainHttp ? "" : "; Secure"}`;
    return new Response(null, { status: 303, headers: { ...COMMON_HEADERS, Location: returnTo, "Set-Cookie": cookie } });
  }

  /** Bot verdict of a correct answer (spec 007); probe values stay inside this function. */
  function judge(request: Request, c: Client, ip: IpValue, result: Extract<AnswerResult, { ok: true }>, probeText: string | null) {
    const bot = deps.bot!;
    const headers = request.headers;
    const probe = result.kind === "pow" ? parseProbe(probeText, result.nonce) : null;
    const verdict = verdictOf(ip);
    const codes = collectEvidence({
      kind: result.kind,
      probe,
      request: {
        userAgent: headers.get("user-agent"),
        acceptLanguage: headers.get("accept-language"),
        secChUa: headers.get("sec-ch-ua"),
        secChUaPlatform: headers.get("sec-ch-ua-platform"),
        https: c.https,
        ja4: c.viaProxy ? headers.get("x-ja4") : null,
      },
      country: verdict?.network.country ?? null,
      zones: bot.zones,
      families: bot.families,
    });
    const scored = scoreVerdict(verdict?.level ?? null, codes, bot.weights);
    return { scored, ...decideAction(scored, bot.policy, result.stepUp) };
  }

  function logDecision(action: BotAction, would: BotAction, ip: IpValue, result: Extract<AnswerResult, { ok: true }>, scored: BotVerdict) {
    const bits = result.kind === "pow" ? ` bits=${result.bits}` : "";
    const mode = deps.bot!.policy.mode;
    const wouldText = mode === "observe" ? ` would=${would}` : "";
    log(`challenge: ${action} ${formatIp(ip)} kind=${result.kind}${bits} bot=${scored.score.toFixed(2)} mode=${mode}${wouldText} reasons=${formatReasons(scored)}`);
  }

  /** The outcome of an answer: a pass and the way back, a step-up, a block, or the page again. */
  function settle(request: Request, c: Client, result: AnswerResult, ip: IpValue, returnTo: string, challenge: string, probeText: string | null): Response {
    const address = formatIp(ip);
    if (result.ok) {
      if (!botOn) {
        log(`challenge: pass ${address} kind=${result.kind}${result.kind === "pow" ? ` bits=${result.bits}` : ""}`);
        return passResponse(ip, returnTo, c.plainHttp);
      }
      const { scored, action, would } = judge(request, c, ip, result, probeText);
      logDecision(action, would, ip, result, scored);
      if (action === "block") return new Response(renderBlocked({ disputeUrl: deps.loader.disputeUrl() }), { status: 403, headers: pageHeaders() });
      if (action === "stepup") return page(ip, returnTo, true);
      return passResponse(ip, returnTo, c.plainHttp);
    }
    log(`challenge: refused ${address} reason=${result.reason}${result.bits === undefined ? "" : ` bits=${result.bits}`}`);
    if (result.reason === "malformed") return malformed();
    if (result.reason === "early") {
      const html = renderWaitPage({ path, challenge, returnTo, remainingSeconds: result.remainingSeconds ?? 1 });
      return new Response(html, { status: 200, headers: pageHeaders() });
    }
    return page(ip, returnTo);
  }

  const script = (name: keyof ChallengeAssets) => () =>
    new Response(deps.assets[name], { headers: { ...COMMON_HEADERS, "Content-Type": "text/javascript; charset=utf-8" } });

  return new Elysia({ name: "foxtrust-challenge" })
    .get(path, ({ request, server, query }) => {
      const c = client(request, server?.requestIP(request)?.address ?? null);
      if (!c.ip) return malformed();
      return page(c.ip, sanitizeReturn(typeof query.return === "string" ? query.return : null, c.host));
    })
    .post(
      path,
      async ({ request, server }) => {
        const c = client(request, server?.requestIP(request)?.address ?? null);
        const type = request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
        const body = await readBody(request, MAX_ANSWER_BYTES);
        if (!c.ip) return malformed();
        if (body === null || type !== "application/x-www-form-urlencoded") return settle(request, c, { ok: false, reason: "malformed" }, c.ip, "/", "", null);
        const form = new URLSearchParams(body);
        const challenge = form.get("c");
        const returnTo = sanitizeReturn(form.get("r"), c.host);
        const result = checkAnswer({
          challenge, solution: form.get("s") ?? "", ip: c.ip, secret, noJs: settings.noJs, replay: deps.replay, now: deps.clock(),
        });
        return settle(request, c, result, c.ip, returnTo, challenge ?? "", form.get("p"));
      },
      { parse: "none" },
    )
    .get(`${path}/wait`, ({ request, server, query }) => {
      const c = client(request, server?.requestIP(request)?.address ?? null);
      if (!c.ip) return malformed();
      const challenge = typeof query.c === "string" ? query.c : null;
      const returnTo = sanitizeReturn(typeof query.r === "string" ? query.r : null, c.host);
      const result = checkAnswer({ challenge, solution: null, ip: c.ip, secret, noJs: settings.noJs, replay: deps.replay, now: deps.clock() });
      return settle(request, c, result, c.ip, returnTo, challenge ?? "", null);
    })
    .get(`${path}/page.js`, script("page.js"))
    .get(`${path}/worker.js`, script("worker.js"));
}
