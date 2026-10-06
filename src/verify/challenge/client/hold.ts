import type { BehaviorPayload, HoldKind } from "../../bot/behavior-types.ts";

/**
 * The press-and-hold control (spec 009 research R2, R4). It records the visitor's own input from the
 * moment it starts until the button is released after a full one-second hold: pointer positions
 * relative to the button, Space/Enter timing with the repeat flag (never other keys or values),
 * untrusted events and visibility changes. Releasing early resets it.
 */

export const HOLD_MS = 1000;
const MAX_PTR = 150;
const MAX_KEYS = 100;
const MAX_VIS = 20;

/** Smallest non-zero step of performance.now(): coarse when a browser resists fingerprinting. */
function timerResolution(): number {
  let smallest = Infinity;
  let last = performance.now();
  const until = last + 5;
  while (last < until) {
    const now = performance.now();
    if (now > last) smallest = Math.min(smallest, now - last);
    last = now;
  }
  return Number.isFinite(smallest) ? Math.min(1000, Math.round(smallest * 1000) / 1000) : 1000;
}

export function runHold(opts: {
  button: HTMLButtonElement;
  progress: HTMLProgressElement;
  show: (text: string) => void;
}): Promise<BehaviorPayload> {
  const { button, progress, show } = opts;
  const started = performance.now();
  const rel = () => Math.round(performance.now() - started);
  const res = timerResolution();
  const ptr: [number, number, number][] = [];
  const keys: [number, "d" | "u", 0 | 1][] = [];
  const vis: [number, "h" | "v" | "f" | "b"][] = [];
  let untrusted = 0;
  let kind: HoldKind = "mouse";
  let pressAt: number | null = null;
  let press: [number, number | null, number | null] = [0, null, null];
  let moves = { count: 0, maxPx: 0 };
  let frame = 0;

  const box = () => button.getBoundingClientRect();
  const local = (x: number, y: number): [number, number] => {
    const r = box();
    return [Math.round(x - r.left), Math.round(y - r.top)];
  };
  const trust = (event: Event) => {
    if (!event.isTrusted) untrusted++;
  };

  return new Promise((resolve) => {
    const tick = () => {
      if (pressAt === null) return;
      const held = performance.now() - pressAt;
      progress.value = Math.min(HOLD_MS, held);
      if (held >= HOLD_MS) {
        show("Done. You can let go now.");
        // A short buzz tells a finger on the screen that the bar is full (Android; iOS has no Vibration API).
        try {
          if (typeof navigator.vibrate === "function") navigator.vibrate(40);
        } catch {
          // Vibration is a convenience only.
        }
        return;
      }
      frame = requestAnimationFrame(tick);
    };

    const start = (k: HoldKind, x: number | null, y: number | null) => {
      if (pressAt !== null) return;
      kind = k;
      pressAt = performance.now();
      press = [rel(), x, y];
      moves = { count: 0, maxPx: 0 };
      show("Keep holding…");
      frame = requestAnimationFrame(tick);
    };

    const finish = () => {
      if (pressAt === null) return;
      const held = performance.now() - pressAt;
      cancelAnimationFrame(frame);
      if (held < HOLD_MS) {
        pressAt = null;
        progress.value = 0;
        show("Hold a little longer, until the bar is full.");
        return;
      }
      cleanup();
      const r = box();
      resolve({
        n: "", res, box: { w: Math.max(1, Math.round(r.width)), h: Math.max(1, Math.round(r.height)) }, kind,
        ptr: ptr.slice(-MAX_PTR), press, release: rel(), moves, keys: keys.slice(0, MAX_KEYS), untrusted, vis: vis.slice(0, MAX_VIS),
      });
    };

    const onMove = (e: PointerEvent) => {
      trust(e);
      const [x, y] = local(e.clientX, e.clientY);
      ptr.push([rel(), x, y]);
      if (ptr.length > MAX_PTR * 2) ptr.splice(0, ptr.length - MAX_PTR);
      if (pressAt !== null && press[1] !== null && press[2] !== null) {
        moves.count++;
        moves.maxPx = Math.max(moves.maxPx, Math.round(Math.hypot(x - press[1], y - press[2])));
      }
    };
    const onDown = (e: PointerEvent) => {
      trust(e);
      button.setPointerCapture(e.pointerId);
      const [x, y] = local(e.clientX, e.clientY);
      start(e.pointerType === "touch" ? "touch" : e.pointerType === "pen" ? "pen" : "mouse", x, y);
    };
    const onUp = (e: PointerEvent) => {
      trust(e);
      finish();
    };
    const onCancel = () => {
      if (pressAt === null) return;
      cancelAnimationFrame(frame);
      pressAt = null;
      progress.value = 0;
    };
    const isHoldKey = (e: KeyboardEvent) => e.key === " " || e.key === "Enter";
    const onKeyDown = (e: KeyboardEvent) => {
      if (!isHoldKey(e)) return;
      e.preventDefault();
      trust(e);
      keys.push([rel(), "d", e.repeat ? 1 : 0]);
      start("key", null, null);
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (!isHoldKey(e)) return;
      e.preventDefault();
      trust(e);
      keys.push([rel(), "u", 0]);
      finish();
    };
    const onVisibility = () => vis.push([rel(), document.visibilityState === "hidden" ? "h" : "v"]);
    const onFocus = () => vis.push([rel(), "f"]);
    const onBlur = () => vis.push([rel(), "b"]);

    document.addEventListener("pointermove", onMove);
    button.addEventListener("pointerdown", onDown);
    button.addEventListener("pointerup", onUp);
    button.addEventListener("pointercancel", onCancel);
    button.addEventListener("keydown", onKeyDown);
    button.addEventListener("keyup", onKeyUp);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    button.disabled = false;
    show("Press and hold the button until the bar is full, then let go. With a keyboard: Tab to it and hold Space or Enter.");

    function cleanup() {
      document.removeEventListener("pointermove", onMove);
      button.removeEventListener("pointerdown", onDown);
      button.removeEventListener("pointerup", onUp);
      button.removeEventListener("pointercancel", onCancel);
      button.removeEventListener("keydown", onKeyDown);
      button.removeEventListener("keyup", onKeyUp);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
      button.disabled = true;
    }
  });
}
