import type { ActiveKey } from "./accounts";

/**
 * The keys the API accepts, held in memory (spec 010 research R3). Lookups never query the
 * database; the set is reloaded every 30 s, so a new, changed or revoked key takes effect within
 * a minute. A failed reload keeps the last good set.
 */

export const KEY_RELOAD_MS = 30_000;

export type KeySetStatus = { active: number; lastReloadAt: string | null; lastReloadError: string | null };

export function createKeySet(opts: {
  load: () => Promise<ActiveKey[]>;
  clock?: () => Date;
  log?: (line: string) => void;
  intervalMs?: number;
}) {
  const clock = opts.clock ?? (() => new Date());
  const log = opts.log ?? (() => {});
  const intervalMs = opts.intervalMs ?? KEY_RELOAD_MS;
  let keys = new Map<string, ActiveKey>();
  let loaded = false;
  let lastReloadAt: Date | null = null;
  let lastReloadError: string | null = null;
  let running: Promise<boolean> | null = null;

  async function load(): Promise<boolean> {
    try {
      const rows = await opts.load();
      keys = new Map(rows.map((k) => [k.id, k]));
      loaded = true;
      if (lastReloadError) log(`api: key reload recovered (${keys.size} active keys)`);
      lastReloadError = null;
      return true;
    } catch (error) {
      // One line per failure streak, not one per attempt.
      if (!lastReloadError) log(`api: key reload failed, keeping ${keys.size} keys: ${(error as Error).message}`);
      lastReloadError = (error as Error).message;
      return false;
    } finally {
      lastReloadAt = clock();
    }
  }

  const keySet = {
    /** Reloads now; concurrent callers share one reload. */
    reload(): Promise<boolean> {
      running ??= load().finally(() => {
        running = null;
      });
      return running;
    },
    find: (id: string) => keys.get(id),
    loaded: () => loaded,
    size: () => keys.size,
    status: (): KeySetStatus => ({ active: keys.size, lastReloadAt: lastReloadAt?.toISOString() ?? null, lastReloadError }),
    /**
     * Reloads whenever `intervalMs` has passed on the clock, checking every `pollMs` of real time;
     * returns a stop function. Measuring the interval on the clock lets tests move time forward.
     */
    start(pollMs = 1000): () => void {
      const timer = setInterval(() => {
        if (!lastReloadAt || clock().getTime() - lastReloadAt.getTime() >= intervalMs) void keySet.reload();
      }, pollMs);
      return () => clearInterval(timer);
    },
  };
  return keySet;
}

export type KeySet = ReturnType<typeof createKeySet>;
