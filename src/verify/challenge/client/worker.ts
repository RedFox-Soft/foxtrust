import { solve } from "../pow.ts";

/**
 * Web Worker of the challenge page (spec 006 research R8): solves the proof-of-work off the main
 * thread and reports progress. Message in: {n (base64url nonce), d (bits)}.
 */

type SolveRequest = { n: string; d: number };
type WorkerScope = { onmessage: ((event: MessageEvent<SolveRequest>) => void) | null; postMessage(message: unknown): void };

const scope = globalThis as unknown as WorkerScope;

function fromBase64url(text: string): Uint8Array {
  const base64 = text.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(text.length / 4) * 4, "=");
  return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
}

scope.onmessage = (event) => {
  const { n, d } = event.data;
  const s = solve(fromBase64url(n), d, (tried) => scope.postMessage({ type: "progress", tried }));
  scope.postMessage({ type: "done", s: s.toString() });
};
