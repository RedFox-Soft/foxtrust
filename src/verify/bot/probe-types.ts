/**
 * The probe result the challenge page sends in form field `p` (spec 007 data-model.md). Types only:
 * shared by the browser probe and the server, with no Bun or DOM dependency.
 */

export type Engine = "chromium" | "gecko" | "webkit" | "unknown";

export type ProbeResult = {
  /** The challenge nonce (binding); recorded samples store "*". */
  n: string;
  webdriver: boolean;
  cdp: boolean;
  globals: number;
  uaHeadless: boolean;
  ua: string;
  uaData: { brands: { brand: string; version: string }[]; mobile: boolean; platform: string } | null;
  engine: Engine;
  gl: "soft" | "hw" | "unknown";
  tz: string;
  langs: string[];
  screen: { sw: number; sh: number; iw: number; ih: number; ow: number; oh: number; dpr: number };
  perm: boolean;
  err: string[];
};
