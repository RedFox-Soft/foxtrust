import { Elysia } from "elysia";
import { contains, type Cidr } from "../../ip/cidr";
import { formatIp, type IpValue } from "../../ip/parse";
import { clientAddress } from "../client-ip";
import type { ChallengeSettings, DifficultyKey } from "../config";
import type { Loader } from "../loader";
import { b64url, issuePassTokenV2 } from "../token";
import type { ChallengeAssets } from "./assets";
import { checkAnswer, issueChallenge, readChallenge, type AnswerResult } from "./challenge";
import { COMMON_HEADERS, pageHeaders, renderChallengePage, renderMalformed, renderWaitPage } from "./page";
import type { ReplayCache } from "./replay";
import { sanitizeReturn } from "./return-url";

/**
 * Routes of the built-in challenge page (spec 006 contracts/challenge-http.md), served by
 * `verify` on a path of each protected host that the operator's proxy routes to it.
 */

export const PASS_COOKIE = "foxtrust_pass";
export const MAX_ANSWER_BYTES = 4096;

export type ChallengeRouteDeps = {
  settings: ChallengeSettings & { path: string };
  secret: string;
  trustedProxies: Cidr[];
  loader: Pick<Loader, "source">;
  replay: ReplayCache;
  assets: ChallengeAssets;
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

export function challengeRoutes(deps: ChallengeRouteDeps) {
  const { settings, secret, log } = deps;
  const { path } = settings;

  /** Client address, host and protocol, trusting forwarded headers only from trusted proxies. */
  function client(request: Request, peerAddress: string | null) {
    const headers = request.headers;
    const ip = clientAddress(peerAddress, headers.get("x-forwarded-for"), deps.trustedProxies);
    const peer = peerAddress === null ? null : clientAddress(peerAddress, null, []);
    const viaProxy = peer !== null && deps.trustedProxies.some((cidr) => contains(cidr, peer));
    const host = (viaProxy ? headers.get("x-forwarded-host") : null) ?? headers.get("host");
    const plainHttp = viaProxy && headers.get("x-forwarded-proto")?.trim().toLowerCase() === "http";
    return { ip, host, plainHttp };
  }

  function bitsFor(ip: IpValue): number {
    const source = deps.loader.source();
    const verdict = source.snapshotVersion === null ? null : source.lookup(ip);
    const key: DifficultyKey = verdict ? verdict.level : "none";
    return settings.difficulty[key];
  }

  function page(ip: IpValue, returnTo: string, status = 200): Response {
    const now = deps.clock();
    const bits = bitsFor(ip);
    const challenge = issueChallenge({ kind: "pow", ip, bits, ttlSeconds: settings.challengeTtlSeconds, secret, now });
    const wait = settings.noJs
      ? {
          challenge: issueChallenge({
            kind: "wait", ip, bits: 0, ttlSeconds: settings.challengeTtlSeconds, waitSeconds: settings.waitSeconds, secret, now,
          }),
          seconds: settings.waitSeconds,
        }
      : null;
    const html = renderChallengePage({ path, challenge, nonce: b64url(readChallenge(challenge)!.nonce), bits, returnTo, wait });
    return new Response(html, { status, headers: pageHeaders() });
  }

  const malformed = () => new Response(renderMalformed(), { status: 400, headers: pageHeaders() });

  /** The outcome of an answer: a pass and the way back, or the page again. */
  function settle(result: AnswerResult, ip: IpValue, returnTo: string, plainHttp: boolean, challenge: string): Response {
    const address = formatIp(ip);
    if (result.ok) {
      log(`challenge: pass ${address} kind=${result.kind}${result.kind === "pow" ? ` bits=${result.bits}` : ""}`);
      const token = issuePassTokenV2(ip, settings.passTtlMinutes * 60, secret, deps.clock());
      const cookie = `${PASS_COOKIE}=${token}; Path=/; Max-Age=${settings.passTtlMinutes * 60}; HttpOnly; SameSite=Lax${plainHttp ? "" : "; Secure"}`;
      return new Response(null, { status: 303, headers: { ...COMMON_HEADERS, Location: returnTo, "Set-Cookie": cookie } });
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
      const { ip, host } = client(request, server?.requestIP(request)?.address ?? null);
      if (!ip) return malformed();
      return page(ip, sanitizeReturn(typeof query.return === "string" ? query.return : null, host));
    })
    .post(
      path,
      async ({ request, server }) => {
        const { ip, host, plainHttp } = client(request, server?.requestIP(request)?.address ?? null);
        const type = request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
        const body = await readBody(request, MAX_ANSWER_BYTES);
        if (!ip) return malformed();
        if (body === null || type !== "application/x-www-form-urlencoded") return settle({ ok: false, reason: "malformed" }, ip, "/", plainHttp, "");
        const form = new URLSearchParams(body);
        const challenge = form.get("c");
        const returnTo = sanitizeReturn(form.get("r"), host);
        const result = checkAnswer({
          challenge, solution: form.get("s") ?? "", ip, secret, noJs: settings.noJs, replay: deps.replay, now: deps.clock(),
        });
        return settle(result, ip, returnTo, plainHttp, challenge ?? "");
      },
      { parse: "none" },
    )
    .get(`${path}/wait`, ({ request, server, query }) => {
      const { ip, host, plainHttp } = client(request, server?.requestIP(request)?.address ?? null);
      if (!ip) return malformed();
      const challenge = typeof query.c === "string" ? query.c : null;
      const returnTo = sanitizeReturn(typeof query.r === "string" ? query.r : null, host);
      const result = checkAnswer({ challenge, solution: null, ip, secret, noJs: settings.noJs, replay: deps.replay, now: deps.clock() });
      return settle(result, ip, returnTo, plainHttp, challenge ?? "");
    })
    .get(`${path}/page.js`, script("page.js"))
    .get(`${path}/worker.js`, script("worker.js"));
}
