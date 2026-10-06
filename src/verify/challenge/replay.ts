/**
 * Accepted challenge nonces, per `verify` instance (spec 006 research R4). Only accepted answers
 * are added, so every entry cost its client a proof-of-work.
 *
 * At the cap the oldest entry is evicted; the cache never refuses. Refusing would let one address
 * lock every visitor out by filling it, while replaying an evicted answer only gives its own
 * address a pass it already holds.
 */
export type ReplayCache = {
  has(nonce: string): boolean;
  add(nonce: string, exp: number, nowSeconds: number): void;
  size(): number;
};

export const REPLAY_CAP = 100_000;

export function createReplayCache(cap = REPLAY_CAP): ReplayCache {
  // Insertion order is acceptance order; with one challenge lifetime per instance it is also
  // close to expiry order, so the oldest entries sit at the front.
  const entries = new Map<string, number>();
  return {
    has: (nonce) => entries.has(nonce),
    add(nonce, exp, nowSeconds) {
      for (const [key, until] of entries) {
        if (until > nowSeconds) break;
        entries.delete(key);
      }
      while (entries.size >= cap) {
        const oldest = entries.keys().next();
        if (oldest.done) break;
        entries.delete(oldest.value);
      }
      entries.set(nonce, exp);
    },
    size: () => entries.size,
  };
}
