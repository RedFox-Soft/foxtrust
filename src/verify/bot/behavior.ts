import type { BehaviorPayload } from "./behavior-types";
import type { ReasonCode } from "./weights";

/**
 * Behavior features of the press-and-hold step (spec 009 research R3), computed in memory and turned
 * into reason codes; the payload is dropped by the caller after this. Each rule targets one known
 * scripting habit; none is decisive alone except untrusted events.
 */

export const HOLD_MS = 1000;
/** Pointer samples considered "the approach": the last ones before the press within this window. */
const APPROACH_MS = 1500;

type Pt = { t: number; x: number; y: number };

function approachOf(p: BehaviorPayload): Pt[] {
  const [pressT] = p.press;
  return p.ptr.filter(([t]) => t <= pressT && t >= pressT - APPROACH_MS).map(([t, x, y]) => ({ t, x, y }));
}

/** Path ends at the press point when it is known. */
function withPress(p: BehaviorPayload, pts: Pt[]): Pt[] {
  const [t, x, y] = p.press;
  return x === null || y === null ? pts : [...pts, { t, x, y }];
}

const dist = (a: Pt, b: Pt) => Math.hypot(b.x - a.x, b.y - a.y);

/** Largest distance of any point from the chord first→last. */
function maxDeviation(pts: Pt[]): number {
  const a = pts[0]!;
  const b = pts.at(-1)!;
  const len = dist(a, b);
  if (len === 0) return 0;
  return Math.max(...pts.map((p) => Math.abs((b.x - a.x) * (a.y - p.y) - (a.x - p.x) * (b.y - a.y)) / len));
}

const pathLength = (pts: Pt[]) => pts.slice(1).reduce((sum, p, i) => sum + dist(pts[i]!, p), 0);

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length === 0 ? 0 : sorted[Math.floor(sorted.length / 2)]!;
}

/** Sign changes of the turn direction along the path (people make micro-corrections). */
function curvatureSignChanges(pts: Pt[]): number {
  let last = 0;
  let changes = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const a = pts[i - 1]!;
    const b = pts[i]!;
    const c = pts[i + 1]!;
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    const sign = Math.sign(cross);
    if (sign === 0) continue;
    if (last !== 0 && sign !== last) changes++;
    last = sign;
  }
  return changes;
}

export function behaviorCodes(p: BehaviorPayload): Set<ReasonCode> {
  const codes = new Set<ReasonCode>();
  const res = Math.max(p.res, 1);
  const held = p.release - p.press[0];

  if (p.untrusted > 0) codes.add("behavior.untrusted");

  if (p.kind === "mouse" || p.kind === "pen") {
    const approach = approachOf(p);
    const recent = approach.filter((pt) => pt.t >= p.press[0] - 600);
    if (recent.length < 3) codes.add("behavior.teleport");

    const path = withPress(p, approach);
    if (path.length >= 10) {
      const chord = dist(path[0]!, path.at(-1)!);
      const length = pathLength(path);
      if (chord > 20 && maxDeviation(path) < 1.5 && chord / length >= 0.995) codes.add("behavior.straight");

      // Browsers deliver pointer moves about once per frame; dozens within a few ms is a script.
      const dts = path.slice(1).map((pt, i) => pt.t - path[i]!.t);
      if (res < 4 && median(dts) < 4) codes.add("behavior.machine_timing");

      if (path.length >= 15 && !codes.has("behavior.straight") && chord > 20 && curvatureSignChanges(path) <= 1) {
        codes.add("behavior.smooth_curve");
      }
    }

    // People stop on the control before pressing it; generated paths press at the end of the motion.
    if (approach.length > 0 && pathLength(withPress(p, approach.filter((pt) => pt.t >= p.press[0] - 100))) >= 10) {
      codes.add("behavior.press_in_motion");
    }

    const [, px, py] = p.press;
    if (px !== null && py !== null && Math.abs(px - p.box.w / 2) <= 0.5 && Math.abs(py - p.box.h / 2) <= 0.5) codes.add("behavior.exact_center");
  }

  // People release after they see the ring full, a reaction time later; a script releases at once.
  if (p.res < 5 && held >= HOLD_MS && held - HOLD_MS <= 30) codes.add("behavior.exact_hold");

  if (p.kind === "key" && held >= 700 && !p.keys.some(([, type, repeat]) => type === "d" && repeat === 1)) codes.add("behavior.no_key_repeat");
  if (p.kind === "touch" && held >= 700 && p.moves.count === 0) codes.add("behavior.still_touch");
  return codes;
}
