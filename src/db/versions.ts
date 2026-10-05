import type { SQL } from "bun";
import type { ScoringConfig } from "../model/types";
import { configSha256 } from "../scoring/config";
import type { Db } from "./client";

export type DataVersionCause = "feed_run" | "retention" | "config";

export type DataVersion = {
  id: number;
  label: string;
  committedAt: Date;
  scoringConfigId: number;
};

export type ResolvedVersion = DataVersion & { config: ScoringConfig };

const toNumber = (v: unknown) => Number(v);
const toBody = (v: unknown): ScoringConfig => (typeof v === "string" ? JSON.parse(v) : v) as ScoringConfig;

/**
 * Creates a data version in the current transaction. `committed_at` is the transaction
 * timestamp, the same value every interval bound written in this transaction uses.
 * Without `scoringConfigId`, the version keeps the config of the current latest version.
 */
export async function createDataVersion(
  tx: SQL,
  opts: { cause: DataVersionCause; feedRunId?: number; scoringConfigId?: number },
): Promise<DataVersion> {
  let configId = opts.scoringConfigId;
  if (configId === undefined) {
    const [latest] = await tx`
      SELECT scoring_config_id FROM data_version ORDER BY committed_at DESC, id DESC LIMIT 1`;
    if (!latest) throw new Error("no scoring configuration is active; run `foxtrust config activate <file>`");
    configId = toNumber(latest.scoring_config_id);
  }
  const [config] = await tx`SELECT algorithm_version, sha256 FROM scoring_config WHERE id = ${configId}`;
  if (!config) throw new Error(`scoring configuration ${configId} does not exist`);

  const [{ id }] = await tx`SELECT nextval(pg_get_serial_sequence('data_version', 'id')) AS id`;
  const label = `dv${id}.${config.algorithm_version}.${String(config.sha256).slice(0, 8)}`;
  const [row] = await tx`
    INSERT INTO data_version (id, label, committed_at, scoring_config_id, cause, feed_run_id)
    VALUES (${id}, ${label}, now(), ${configId}, ${opts.cause}, ${opts.feedRunId ?? null})
    RETURNING id, label, committed_at, scoring_config_id`;
  return {
    id: toNumber(row.id),
    label: row.label,
    committedAt: new Date(row.committed_at),
    scoringConfigId: toNumber(row.scoring_config_id),
  };
}

/** Stores the config (once per distinct body) and makes it active with a new data version. */
export async function activateConfig(sql: Db, config: ScoringConfig): Promise<DataVersion> {
  const sha = configSha256(config);
  return sql.begin<DataVersion>(async (tx) => {
    let [row] = await tx`SELECT id FROM scoring_config WHERE sha256 = ${sha}`;
    if (!row) {
      [row] = await tx`
        INSERT INTO scoring_config (version, algorithm_version, body, sha256)
        VALUES (${config.version}, ${config.algorithm}, ${JSON.stringify(config)}::jsonb, ${sha})
        RETURNING id`;
    }
    return createDataVersion(tx, { cause: "config", scoringConfigId: toNumber(row.id) });
  });
}

/** The data version current at `at` (latest with committed_at <= at), with its config. */
export async function resolveVersionAt(sql: SQL, at: Date): Promise<ResolvedVersion | null> {
  const [row] = await sql`
    SELECT dv.id, dv.label, dv.committed_at, dv.scoring_config_id, sc.body
    FROM data_version dv JOIN scoring_config sc ON sc.id = dv.scoring_config_id
    WHERE dv.committed_at <= ${at}
    ORDER BY dv.committed_at DESC, dv.id DESC
    LIMIT 1`;
  if (!row) return null;
  return {
    id: toNumber(row.id),
    label: row.label,
    committedAt: new Date(row.committed_at),
    scoringConfigId: toNumber(row.scoring_config_id),
    config: toBody(row.body),
  };
}
