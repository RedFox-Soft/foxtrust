import { utcDay, type ActiveKey, type UsageIncrement, type UsageOutcome } from "./accounts";

/**
 * Rate limits and usage counts of the API (spec 010 research R4, R5), in memory per instance:
 * a token bucket per key for the burst rate, and a counter per key and UTC day for the quota.
 * Increments are flushed to `api_usage_daily` every 10 s; the day's counts are seeded from it at
 * start, so a restart does not refill a used quota. Only answered lookups count against the quota.
 */

export const FLUSH_MS = 10_000;
const DAY_MS = 86_400_000;

export type LimitHeaders = { limit: number; remaining: number; reset: number };
export type LimitCheck =
  | { ok: true; headers: LimitHeaders }
  | { ok: false; code: "quota_exceeded" | "rate_limited"; retryAfter: number; headers: LimitHeaders };

type Bucket = { tokens: number; at: number; burst: number };
type Pending = UsageIncrement;

export type LimitsStatus = { lastFlushAt: string | null; lastFlushError: string | null };

export function createLimits(opts: {
  store: { answeredOn(day: string): Promise<Map<string, number>>; addUsage(rows: UsageIncrement[]): Promise<void> };
  clock?: () => Date;
  log?: (line: string) => void;
  flushMs?: number;
}) {
  const clock = opts.clock ?? (() => new Date());
  const log = opts.log ?? (() => {});
  const flushMs = opts.flushMs ?? FLUSH_MS;
  let day = utcDay(clock());
  let answered = new Map<string, number>();
  const buckets = new Map<string, Bucket>();
  let pending = new Map<string, Pending>();
  let lastFlushAt: Date | null = null;
  let lastFlushError: string | null = null;
  let flushing: Promise<void> | null = null;

  /** Starts a new counting day at 00:00 UTC; pending increments keep their own day. */
  function rollDay(now: Date) {
    const today = utcDay(now);
    if (today !== day) {
      day = today;
      answered = new Map();
    }
  }

  const nextReset = (now: Date) => Math.floor((Date.parse(`${utcDay(now)}T00:00:00Z`) + DAY_MS) / 1000);

  function headers(key: ActiveKey, now: Date): LimitHeaders {
    return { limit: key.dailyQuota, remaining: Math.max(0, key.dailyQuota - (answered.get(key.id) ?? 0)), reset: nextReset(now) };
  }

  function takeToken(key: ActiveKey, nowMs: number): number {
    let bucket = buckets.get(key.id);
    if (!bucket || bucket.burst !== key.burst) {
      bucket = { tokens: key.burst, at: nowMs, burst: key.burst };
      buckets.set(key.id, bucket);
    }
    bucket.tokens = Math.min(key.burst, bucket.tokens + ((nowMs - bucket.at) / 1000) * key.burst);
    bucket.at = nowMs;
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return 0;
    }
    // Seconds until one token is back, at least one.
    return Math.max(1, Math.ceil((1 - bucket.tokens) / key.burst));
  }

  const limits = {
    /** Loads today's answered counts (at start). */
    async seed(): Promise<void> {
      const now = clock();
      rollDay(now);
      const stored = await opts.store.answeredOn(day);
      for (const [id, count] of stored) answered.set(id, Math.max(answered.get(id) ?? 0, count));
    },

    /** Checks a request of a valid key before it is served; takes a burst token unless the quota is used. */
    check(key: ActiveKey): LimitCheck {
      const now = clock();
      rollDay(now);
      const h = headers(key, now);
      if (h.remaining <= 0) return { ok: false, code: "quota_exceeded", retryAfter: Math.max(1, h.reset - Math.floor(now.getTime() / 1000)), headers: h };
      const wait = takeToken(key, now.getTime());
      if (wait > 0) return { ok: false, code: "rate_limited", retryAfter: wait, headers: h };
      return { ok: true, headers: h };
    },

    /** Counts one outcome; returns the headers after it. */
    record(key: ActiveKey, outcome: UsageOutcome): LimitHeaders {
      const now = clock();
      rollDay(now);
      if (outcome === "answered") answered.set(key.id, (answered.get(key.id) ?? 0) + 1);
      const slot = `${key.id}|${day}`;
      const row = pending.get(slot) ?? { keyId: key.id, day, answered: 0, invalid: 0, limited: 0, lastUsedAt: null };
      row[outcome]++;
      row.lastUsedAt = now;
      pending.set(slot, row);
      return headers(key, now);
    },

    headers: (key: ActiveKey) => headers(key, clock()),

    /** Writes pending increments; on failure they stay pending for the next flush. */
    flush(): Promise<void> {
      flushing ??= (async () => {
        const batch = pending;
        pending = new Map();
        try {
          await opts.store.addUsage([...batch.values()]);
          if (lastFlushError) log("api: usage flush recovered");
          lastFlushError = null;
        } catch (error) {
          for (const [slot, row] of batch) {
            const later = pending.get(slot);
            pending.set(slot, later
              ? { ...row, answered: row.answered + later.answered, invalid: row.invalid + later.invalid, limited: row.limited + later.limited, lastUsedAt: later.lastUsedAt }
              : row);
          }
          if (!lastFlushError) log(`api: usage flush failed, ${batch.size} rows kept for the next try: ${(error as Error).message}`);
          lastFlushError = (error as Error).message;
        } finally {
          lastFlushAt = clock();
        }
      })().finally(() => {
        flushing = null;
      });
      return flushing;
    },

    status: (): LimitsStatus => ({ lastFlushAt: lastFlushAt?.toISOString() ?? null, lastFlushError }),

    /** Flushes whenever `flushMs` has passed on the clock, checking every `pollMs` of real time. */
    start(pollMs = 1000): () => void {
      let last = clock().getTime();
      const timer = setInterval(() => {
        const now = clock().getTime();
        if (now - last >= flushMs) {
          last = now;
          void limits.flush();
        }
      }, pollMs);
      return () => clearInterval(timer);
    },
  };
  return limits;
}

export type Limits = ReturnType<typeof createLimits>;
