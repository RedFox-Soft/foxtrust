import type { SQL } from "bun";
import { createAccounts, FREE_TIER, type Accounts, type TierDefaults } from "../../src/api/accounts";
import { createKeySet, type KeySet } from "../../src/api/keyset";
import { createLimits, type Limits } from "../../src/api/limits";
import { startApiServer } from "../../src/api/server";
import { importTrustedKeys } from "../../src/snapshot/sign";
import { createLoader, type Loader } from "../../src/verify/loader";
import type { TestPublication } from "./publication";

export type TestApi = {
  url: string;
  logs: string[];
  accounts: Accounts;
  keys: KeySet;
  limits: Limits;
  loader: Loader;
  /** Runs the key reload now, so tests never wait for the 30 s timer. */
  reload: () => Promise<boolean>;
  /** Writes pending usage now (the 10 s timer otherwise). */
  flush: () => Promise<void>;
  /** Writes the per-minute summary line now; returns it. */
  summarize: () => string | null;
  /** Starts the key set's own timer (US3-4); returns a stop function. */
  startKeyTimer: (pollMs?: number) => () => void;
  get: (path: string, headers?: Record<string, string>) => Promise<Response>;
  stop: () => Promise<void>;
};

/** The API on a test publication (or none: `pub: null` loads nothing) and a test database. */
export async function startTestApi(opts: { pub: TestPublication | null; sql: SQL; clock?: () => Date; defaults?: TierDefaults }): Promise<TestApi> {
  const logs: string[] = [];
  const log = (line: string) => logs.push(line);
  const clock = opts.clock ?? (() => new Date());
  const accounts = createAccounts(opts.sql, opts.defaults ?? FREE_TIER, clock);
  const keys = createKeySet({ load: () => accounts.activeKeys(), clock, log });
  const limits = createLimits({ store: accounts, clock, log });
  await keys.reload();
  await limits.seed();
  const loader = createLoader({
    // Without a publication, a closed port: nothing ever loads.
    publicationUrl: opts.pub?.url ?? "http://127.0.0.1:1",
    trustedKeys: await importTrustedKeys(opts.pub ? [opts.pub.publicKey] : []),
    maxAgeHours: 26,
    clock,
  });
  if (opts.pub) await loader.check();
  const server = startApiServer({ loader, keys, limits, clock, log, port: 0, hostname: "127.0.0.1" });
  const url = `http://127.0.0.1:${server.port}`;
  return {
    url, logs, accounts, keys, limits, loader,
    reload: () => keys.reload(),
    flush: () => limits.flush(),
    summarize: server.summarize,
    startKeyTimer: (pollMs = 50) => keys.start(pollMs),
    get: (path, headers = {}) => fetch(`${url}${path}`, { headers }),
    stop: server.stop,
  };
}

/** A new account with one key; the key set is reloaded so the key works at once. */
export async function issueTestKey(
  api: TestApi, opts: { label?: string; dailyQuota?: number; burst?: number } = {},
): Promise<{ key: string; id: string; accountId: string }> {
  const account = await api.accounts.createAccount({ name: "Test customer", contact: "ops@example.com" });
  const { key, info } = await api.accounts.issueKey({ accountId: account.id, ...opts });
  await api.reload();
  return { key, id: info.id, accountId: account.id };
}

export const bearer = (key: string) => ({ Authorization: `Bearer ${key}` });

/** A controllable clock: starts at `start`, moves only when told. */
export function testClock(start: Date = new Date()) {
  let now = start.getTime();
  return {
    now: () => new Date(now),
    set: (at: Date) => {
      now = at.getTime();
    },
    advance: (ms: number) => {
      now += ms;
    },
  };
}
