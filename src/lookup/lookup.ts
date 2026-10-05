import { openDb, readSnapshot } from "../db/client";
import { resolveVersionAt } from "../db/versions";
import { formatIp, toIpValue, type IpValue } from "../ip/parse";
import type { LookupOptions, LookupResult, Network, ScoringConfig, Signal, Verdict } from "../model/types";
import { score } from "../scoring/score";
import { BUILTIN_BOGON_SOURCE, gatherSignals } from "./signals";

export type IpTrustOptions = {
  databaseUrl?: string;
  /** Current time; only affects `behaviorHistoryIncomplete` and the default `at`. For tests. */
  clock?: () => Date;
};

export interface IpTrust {
  lookup(ip: string, options?: LookupOptions): Promise<LookupResult>;
  close(): Promise<void>;
}

/** The verdict for `ip` from its signals and network at `at` (pure: the lookup's decision part). */
export function buildVerdict(
  ip: IpValue, signals: Signal[], network: Network, config: ScoringConfig, at: Date, now: Date, dataVersion: string,
): Verdict {
  const result = score(signals, config, at, now);
  return {
    ip: formatIp(ip),
    risk: result.risk,
    level: result.level,
    categories: result.categories,
    reasons: result.reasons,
    network,
    dataVersion,
    evaluatedAt: at.toISOString(),
    behaviorHistoryIncomplete: result.behaviorHistoryIncomplete,
  };
}

/** Opens a read-only lookup client over the local database (FR-001: no external calls). */
export function createIpTrust(options: IpTrustOptions = {}): IpTrust {
  const sql = openDb(options.databaseUrl);
  const clock = options.clock ?? (() => new Date());

  return {
    async lookup(input, opts = {}) {
      const parsed = toIpValue(input);
      if ("error" in parsed) return { ok: false, error: { code: "invalid_ip", message: parsed.error, input } };

      const now = clock();
      const at = opts.at ?? now;
      const exclude = opts.excludeSources ?? [];

      return readSnapshot(sql, async (tx): Promise<LookupResult> => {
        const version = await resolveVersionAt(tx, at);
        if (!version) {
          return {
            ok: false,
            error: { code: "no_data", message: `no data version exists at or before ${at.toISOString()}`, at: at.toISOString() },
          };
        }
        const known = new Set([...Object.keys(version.config.sourceConfidence), BUILTIN_BOGON_SOURCE]);
        const unknown = exclude.find((s) => !known.has(s));
        if (unknown !== undefined) {
          return { ok: false, error: { code: "unknown_source", message: `unknown source "${unknown}"`, source: unknown } };
        }

        const { signals, network } = await gatherSignals(tx, parsed, at, exclude);
        return { ok: true, verdict: buildVerdict(parsed, signals, network, version.config, at, now, version.label) };
      });
    },
    close: () => sql.close(),
  };
}
