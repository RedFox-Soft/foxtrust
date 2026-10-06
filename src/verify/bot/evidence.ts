import { behaviorCodes } from "./behavior";
import type { BehaviorPayload } from "./behavior-types";
import { classifyJa4, type Ja4Families } from "./ja4";
import type { Engine, ProbeResult } from "./probe-types";
import type { ReasonCode } from "./weights";
import type { Zones } from "./zones";

/**
 * Evidence of the bot verdict (spec 007 research R1–R3, R6, R9): the probe result, the answer
 * request's own headers and an optional proxy-supplied JA4 become reason codes. Probe values never
 * leave this function except as codes (constitution Principle IV).
 */

export type RequestFacts = {
  userAgent: string | null;
  acceptLanguage: string | null;
  secChUa: string | null;
  secChUaPlatform: string | null;
  /** The original request came over HTTPS (client hints exist only in secure contexts). */
  https: boolean;
  /** JA4 from a trusted proxy, or null. */
  ja4: string | null;
};

/** The engine a user agent claims. On iOS every browser is WebKit. */
export function claimedEngine(userAgent: string | null): Engine {
  if (!userAgent) return "unknown";
  if (/\b(iPhone|iPad|iPod)\b/.test(userAgent)) return "webkit";
  if (/\bFirefox\//.test(userAgent)) return "gecko";
  if (/\b(Chrome|Chromium|HeadlessChrome)\//.test(userAgent)) return "chromium";
  if (/\bVersion\/[\d.]+ (Mobile\/\S+ )?Safari\//.test(userAgent)) return "webkit";
  return "unknown";
}

/**
 * Zones that resistFingerprinting reports for everyone: UTC in older releases, Atlantic/Reykjavik
 * (UTC+0 without daylight saving) since Firefox 128 ESR / Tor Browser 14.
 */
const SPOOFED_ZONES = new Set(["UTC", "Etc/UTC", "Etc/GMT", "GMT", "Etc/Universal", "Etc/Zulu", "Atlantic/Reykjavik"]);

/**
 * Tor Browser and Firefox resistFingerprinting look the same for everyone (research R3): Gecko, a
 * spoofed UTC zone, English, and the outer window reported equal to the inner one (real Firefox has
 * toolbars, so its outer window is larger). Recorded from Tor Browser 15.0 on 2026-10-06.
 */
export function isUniformProfile(probe: ProbeResult, claimed: Engine): boolean {
  return (
    probe.engine === "gecko" &&
    claimed === "gecko" &&
    SPOOFED_ZONES.has(probe.tz) &&
    probe.langs[0] === "en-US" &&
    probe.screen.iw > 0 &&
    probe.screen.ow === probe.screen.iw &&
    probe.screen.oh === probe.screen.ih
  );
}

const unquote = (value: string | null) => (value ?? "").trim().replace(/^"|"$/g, "");

export function collectEvidence(opts: {
  kind: "pow" | "wait";
  probe: ProbeResult | null;
  request: RequestFacts;
  /** ISO country of the address from the snapshot, or null. */
  country: string | null;
  zones: Zones;
  families: Ja4Families;
  /** The answer was bound to a valid returning-device token (spec 008). */
  returningDevice?: boolean;
  /** Input of the press-and-hold step (spec 009), or null when absent or invalid. */
  behavior?: BehaviorPayload | null;
  /** The hold step was shown, so its input is expected. */
  holdRequired?: boolean;
}): Set<ReasonCode> {
  const { probe, request } = opts;
  const codes = new Set<ReasonCode>();
  const claimed = claimedEngine(request.userAgent);

  if (request.userAgent && /HeadlessChrome/.test(request.userAgent)) codes.add("req.headless_ua");
  if (!request.acceptLanguage) codes.add("req.no_accept_language");
  if (opts.returningDevice) codes.add("attest.returning_device");

  const family = classifyJa4(request.ja4, opts.families);
  if (family?.startsWith("tool:")) codes.add("transport.ja4_tool");
  else if (family && claimed !== "unknown" && family !== claimed) codes.add("transport.ja4_mismatch");

  // No-JavaScript answers have no probe or hold by design (spec 007 research R7).
  if (opts.kind === "wait") return codes;
  if (opts.holdRequired && !opts.behavior) codes.add("behavior.missing");
  if (opts.behavior) for (const code of behaviorCodes(opts.behavior)) codes.add(code);
  if (!probe) {
    codes.add("env.probe_missing");
    return codes;
  }

  if (probe.webdriver) codes.add("env.webdriver");
  if (probe.cdp) codes.add("env.cdp");
  if (probe.globals > 0) codes.add("env.driver_globals");
  if (probe.uaHeadless) codes.add("env.headless_ua");
  if (probe.perm) codes.add("env.perm_inconsistent");
  if (probe.gl === "soft") codes.add("env.software_gl");
  if (probe.screen.ow === 0 || probe.screen.oh === 0 || probe.screen.sw === 0 || probe.screen.sh === 0) codes.add("env.window_zero");

  if (probe.ua && request.userAgent && probe.ua !== request.userAgent.slice(0, 512)) codes.add("env.ua_mismatch");
  if (claimed !== "unknown" && probe.engine !== "unknown" && probe.engine !== claimed) codes.add("env.engine_mismatch");

  if (request.https) {
    const hintsPresent = Boolean(request.secChUa);
    const hintsContradict =
      (hintsPresent && (claimed === "gecko" || claimed === "webkit")) ||
      (probe.uaData !== null && claimed !== "chromium" && claimed !== "unknown") ||
      (probe.uaData !== null && request.secChUaPlatform !== null && probe.uaData.platform !== unquote(request.secChUaPlatform));
    if (hintsContradict) codes.add("env.hints_mismatch");
  }

  const uniform = isUniformProfile(probe, claimed);
  if (uniform) codes.add("profile.uniform");
  const zoneCountries = opts.zones.get(probe.tz);
  if (!uniform && opts.country && zoneCountries && zoneCountries.size > 0 && !zoneCountries.has(opts.country)) {
    codes.add("env.tz_mismatch");
  }
  return codes;
}
