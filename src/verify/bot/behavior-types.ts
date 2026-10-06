/**
 * The input recorded during the press-and-hold step (spec 009 data-model, form field `b`). Types only,
 * shared by the browser control and the server, with no Bun or DOM dependency. Times are ms since the
 * step was shown; positions are CSS px relative to the control's top-left corner.
 */

export type HoldKind = "mouse" | "pen" | "touch" | "key";

export type BehaviorPayload = {
  /** The challenge nonce (binding); recorded samples store "*". */
  n: string;
  /** Smallest non-zero step of performance.now() seen by the page, in ms (coarse under resistFingerprinting). */
  res: number;
  box: { w: number; h: number };
  kind: HoldKind;
  /** Pointer positions [t, x, y] as the browser delivered them, the last 150 (spec 009 research R2). */
  ptr: [number, number, number][];
  press: [number, number | null, number | null];
  release: number;
  /** Pointer or touch moves during the hold, and the largest distance from the press point. */
  moves: { count: number; maxPx: number };
  /** Space/Enter only: [t, "d" | "u", repeat 0/1]; never other keys and never values. */
  keys: [number, "d" | "u", 0 | 1][];
  untrusted: number;
  vis: [number, "h" | "v" | "f" | "b"][];
};
