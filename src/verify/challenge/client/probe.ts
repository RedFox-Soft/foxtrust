import type { Engine, ProbeResult } from "../../bot/probe-types.ts";

/**
 * Environment probe of the challenge page (spec 007 research R1). Every check is cheap and wrapped:
 * a check that throws reports "unknown" and its name in `err`, never a mismatch. Only derived values
 * leave the browser (an engine family, "soft"/"hw" graphics), except the user agent, which the server
 * needs for its comparison.
 */

/** Globals left behind by browser drivers and automation frameworks. */
const DRIVER_GLOBALS = [
  "__playwright__binding__", "__pwInitScripts", "__playwright_evaluation_script__", "__puppeteer_evaluation_script__",
  "__webdriver_evaluate", "__selenium_evaluate", "__webdriver_script_function", "__webdriver_script_func",
  "__webdriver_script_fn", "__fxdriver_evaluate", "__driver_unwrapped", "__webdriver_unwrapped", "__driver_evaluate",
  "__selenium_unwrapped", "__fxdriver_unwrapped", "_Selenium_IDE_Recorder", "_selenium", "calledSelenium",
  "domAutomation", "domAutomationController", "__nightmare", "callPhantom", "_phantom", "phantom", "__lastWatirAlert",
];

type UaData = { brands?: { brand: string; version: string }[]; mobile?: boolean; platform?: string };

export async function runProbe(nonce: string): Promise<ProbeResult> {
  const err: string[] = [];
  const safe = <T>(name: string, fallback: T, fn: () => T): T => {
    try {
      return fn();
    } catch {
      err.push(name);
      return fallback;
    }
  };
  const nav = navigator as Navigator & { userAgentData?: UaData; buildID?: unknown };
  const win = window as unknown as Record<string, unknown>;

  const webdriver = safe("webdriver", false, () => nav.webdriver === true);

  // The automation protocol's Runtime.enable serializes console arguments, which reads `stack`.
  const cdp = safe("cdp", false, () => {
    let hit = false;
    const probe = new Error();
    Object.defineProperty(probe, "stack", {
      configurable: true,
      get() {
        hit = true;
        return "";
      },
    });
    console.debug(probe);
    return hit;
  });

  const globals = safe("globals", 0, () => {
    let count = DRIVER_GLOBALS.filter((name) => name in win).length;
    if (Object.keys(document).some((key) => /^\$?cdc_/.test(key))) count++;
    if (document.documentElement.getAttribute("webdriver") !== null) count++;
    return Math.min(count, 64);
  });

  const ua = safe("ua", "", () => nav.userAgent.slice(0, 512));
  const uaHeadless = /HeadlessChrome/.test(ua);

  const uaData = safe<ProbeResult["uaData"]>("uaData", null, () => {
    const data = nav.userAgentData;
    if (!data) return null;
    return {
      brands: (data.brands ?? []).slice(0, 8).map((b) => ({ brand: String(b.brand).slice(0, 64), version: String(b.version).slice(0, 16) })),
      mobile: data.mobile === true,
      platform: String(data.platform ?? "").slice(0, 32),
    };
  });

  const engine = safe<Engine>("engine", "unknown", () => {
    const chromium = typeof win.chrome === "object" || "userAgentData" in nav;
    const gecko = typeof nav.buildID === "string" || CSS.supports("-moz-appearance", "none");
    const webkit = !chromium && !gecko && ("GestureEvent" in win || CSS.supports("-webkit-touch-callout", "none"));
    if (chromium && !gecko) return "chromium";
    if (gecko && !chromium) return "gecko";
    if (webkit) return "webkit";
    return "unknown";
  });

  const gl = safe<ProbeResult["gl"]>("gl", "unknown", () => {
    const context = document.createElement("canvas").getContext("webgl");
    if (!context) return "unknown";
    const info = context.getExtension("WEBGL_debug_renderer_info");
    if (!info) return "unknown";
    const renderer = String(context.getParameter(info.UNMASKED_RENDERER_WEBGL));
    return /swiftshader|llvmpipe|softpipe|mesa offscreen/i.test(renderer) ? "soft" : "hw";
  });

  const tz = safe("tz", "", () => (Intl.DateTimeFormat().resolvedOptions().timeZone ?? "").slice(0, 64));
  const langs = safe<string[]>("langs", [], () => [...(nav.languages ?? [])].slice(0, 3).map((l) => l.slice(0, 35)));
  // Android Chrome can report a 0×0 outer window for a moment after load; headless Chrome always does.
  for (let i = 0; i < 20 && (outerWidth === 0 || outerHeight === 0); i++) await new Promise((resolve) => setTimeout(resolve, 50));
  const screenSize = safe("screen", { sw: 0, sh: 0, iw: 0, ih: 0, ow: 0, oh: 0, dpr: 0 }, () => ({
    sw: screen.width, sh: screen.height, iw: innerWidth, ih: innerHeight, ow: outerWidth, oh: outerHeight, dpr: devicePixelRatio,
  }));

  // Headless Chrome reports "denied" for notifications while the permissions API says "prompt".
  let perm = false;
  try {
    if (typeof Notification !== "undefined" && Notification.permission === "denied" && nav.permissions) {
      const state = await Promise.race([
        nav.permissions.query({ name: "notifications" as PermissionName }).then((s) => s.state),
        new Promise<string>((resolve) => setTimeout(() => resolve("timeout"), 50)),
      ]);
      perm = state === "prompt";
    }
  } catch {
    err.push("perm");
  }

  return {
    n: nonce, webdriver, cdp, globals, uaHeadless, ua, uaData, engine, gl, tz, langs, screen: screenSize, perm, err: err.slice(0, 16),
  };
}
