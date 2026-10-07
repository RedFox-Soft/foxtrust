import type { SQL } from "bun";
import { displayKey, generateKey } from "./key";

/**
 * The account and key service (spec 010 research R7, FR-012). It is the only code that touches the
 * account, api_key and api_usage_daily tables. Tests call it now; the admin panel (B-16) and the
 * site (B-15) are its interfaces. Every statement is fixed SQL (no SQL built from input).
 */

export type TierDefaults = { dailyQuota: number; burst: number };
export const FREE_TIER: TierDefaults = { dailyQuota: 1000, burst: 5 };
export const LIMITS = { dailyQuota: { min: 1, max: 10_000_000 }, burst: { min: 1, max: 1000 } } as const;

export class ValidationError extends Error {
  constructor(readonly field: string, message: string) {
    super(`${field}: ${message}`);
  }
}
export class NotFoundError extends Error {}

export type Account = { id: string; name: string; contact: string; createdAt: Date; disabledAt: Date | null; keyCount: number };

export type KeyInfo = {
  id: string;
  /** `ftk_<id>_…`: how the key is shown after creation. */
  display: string;
  accountId: string;
  label: string;
  tier: "free";
  /** Effective limits: the override, or the tier default. */
  dailyQuota: number;
  burst: number;
  overrides: { dailyQuota: number | null; burst: number | null };
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  answeredToday: number;
  answeredLast7Days: number;
};

/** A key the API accepts: active, of an enabled account, with effective limits. */
export type ActiveKey = { id: string; sha256: Uint8Array; dailyQuota: number; burst: number };

export type UsageOutcome = "answered" | "invalid" | "limited";
export type UsageDay = { day: string; answered: number; invalid: number; limited: number };
export type UsageIncrement = UsageDay & { keyId: string; lastUsedAt: Date | null };

const DAY_MS = 86_400_000;
/** The UTC day of `at` as `YYYY-MM-DD`. */
export const utcDay = (at: Date) => at.toISOString().slice(0, 10);
const dayText = (value: unknown) => (value instanceof Date ? utcDay(value) : String(value).slice(0, 10));

const randomId = (bytes: number) => Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString("base64url");

function text(field: string, value: unknown, min: number, max: number): string {
  if (typeof value !== "string") throw new ValidationError(field, "must be text");
  const trimmed = value.trim();
  if (trimmed.length < min || trimmed.length > max) throw new ValidationError(field, `must be ${min}–${max} characters`);
  return trimmed;
}

function limit(field: keyof typeof LIMITS, value: number | null | undefined): number | null | undefined {
  if (value === undefined || value === null) return value;
  const { min, max } = LIMITS[field];
  if (!Number.isInteger(value) || value < min || value > max) throw new ValidationError(field, `must be a whole number from ${min} to ${max}`);
  return value;
}

type KeyRow = {
  id: string; account_id: string; label: string; tier: "free"; daily_quota: number | null; burst: number | null;
  created_at: Date; last_used_at: Date | null; revoked_at: Date | null; answered_today: number | string; answered_7d: number | string;
};

export function createAccounts(sql: SQL, defaults: TierDefaults = FREE_TIER, clock: () => Date = () => new Date()) {
  const toInfo = (r: KeyRow): KeyInfo => ({
    id: r.id,
    display: displayKey(r.id),
    accountId: r.account_id,
    label: r.label,
    tier: r.tier,
    dailyQuota: r.daily_quota ?? defaults.dailyQuota,
    burst: r.burst ?? defaults.burst,
    overrides: { dailyQuota: r.daily_quota, burst: r.burst },
    createdAt: r.created_at,
    lastUsedAt: r.last_used_at,
    revokedAt: r.revoked_at,
    answeredToday: Number(r.answered_today ?? 0),
    answeredLast7Days: Number(r.answered_7d ?? 0),
  });

  async function keyRows(accountId: string | null, keyId: string | null): Promise<KeyInfo[]> {
    const now = clock();
    const today = utcDay(now);
    const weekStart = utcDay(new Date(now.getTime() - 6 * DAY_MS));
    const rows = (await sql`
      SELECT k.id, k.account_id, k.label, k.tier, k.daily_quota, k.burst, k.created_at, k.last_used_at, k.revoked_at,
             COALESCE(SUM(u.answered) FILTER (WHERE u.day = ${today}::date), 0) AS answered_today,
             COALESCE(SUM(u.answered) FILTER (WHERE u.day >= ${weekStart}::date), 0) AS answered_7d
      FROM api_key k
      LEFT JOIN api_usage_daily u ON u.key_id = k.id AND u.day >= ${weekStart}::date
      WHERE (${accountId}::text IS NULL OR k.account_id = ${accountId}::text)
        AND (${keyId}::text IS NULL OR k.id = ${keyId}::text)
      GROUP BY k.id
      ORDER BY k.created_at, k.id`) as KeyRow[];
    return rows.map(toInfo);
  }

  async function oneKey(id: string): Promise<KeyInfo> {
    const [row] = await keyRows(null, id);
    if (!row) throw new NotFoundError(`no API key ${id}`);
    return row;
  }

  return {
    defaults,

    async createAccount(input: { name: string; contact: string }): Promise<Account> {
      const name = text("name", input.name, 1, 200);
      const contact = text("contact", input.contact, 1, 320);
      const id = `acc_${randomId(9)}`;
      const createdAt = clock();
      await sql`INSERT INTO account (id, name, contact, created_at) VALUES (${id}, ${name}, ${contact}, ${createdAt})`;
      return { id, name, contact, createdAt, disabledAt: null, keyCount: 0 };
    },

    async listAccounts(): Promise<Account[]> {
      const rows = (await sql`
        SELECT a.id, a.name, a.contact, a.created_at, a.disabled_at, COUNT(k.id) AS key_count
        FROM account a LEFT JOIN api_key k ON k.account_id = a.id
        GROUP BY a.id ORDER BY a.created_at, a.id`) as {
        id: string; name: string; contact: string; created_at: Date; disabled_at: Date | null; key_count: number | string;
      }[];
      return rows.map((r) => ({
        id: r.id, name: r.name, contact: r.contact, createdAt: r.created_at, disabledAt: r.disabled_at, keyCount: Number(r.key_count),
      }));
    },

    /** Every key of the account stops working at the API's next key reload (within a minute). */
    async disableAccount(id: string): Promise<void> {
      const result = await sql`UPDATE account SET disabled_at = COALESCE(disabled_at, ${clock()}) WHERE id = ${id}`;
      if (Number(result.count ?? 0) === 0) throw new NotFoundError(`no account ${id}`);
    },

    /** A new key. The full key is returned here once and never again; only its hash is stored. */
    async issueKey(input: { accountId: string; label?: string; dailyQuota?: number | null; burst?: number | null }): Promise<{ key: string; info: KeyInfo }> {
      const label = input.label === undefined ? "" : text("label", input.label, 0, 100);
      const dailyQuota = limit("dailyQuota", input.dailyQuota) ?? null;
      const burst = limit("burst", input.burst) ?? null;
      const [account] = (await sql`SELECT disabled_at FROM account WHERE id = ${input.accountId}`) as { disabled_at: Date | null }[];
      if (!account) throw new NotFoundError(`no account ${input.accountId}`);
      if (account.disabled_at) throw new ValidationError("accountId", "the account is disabled");
      const key = generateKey();
      await sql`
        INSERT INTO api_key (id, account_id, label, secret_sha256, daily_quota, burst, created_at)
        VALUES (${key.id}, ${input.accountId}, ${label}, ${key.sha256}, ${dailyQuota}, ${burst}, ${clock()})`;
      return { key: key.full, info: await oneKey(key.id) };
    },

    listKeys(filter: { accountId?: string } = {}): Promise<KeyInfo[]> {
      return keyRows(filter.accountId ?? null, null);
    },

    /** `undefined` keeps a limit; `null` clears the override, so the tier default applies. */
    async setKeyLimits(id: string, input: { dailyQuota?: number | null; burst?: number | null }): Promise<KeyInfo> {
      const dailyQuota = limit("dailyQuota", input.dailyQuota);
      const burst = limit("burst", input.burst);
      const result = await sql`
        UPDATE api_key SET
          daily_quota = CASE WHEN ${dailyQuota !== undefined} THEN ${dailyQuota ?? null}::integer ELSE daily_quota END,
          burst = CASE WHEN ${burst !== undefined} THEN ${burst ?? null}::integer ELSE burst END
        WHERE id = ${id}`;
      if (Number(result.count ?? 0) === 0) throw new NotFoundError(`no API key ${id}`);
      return oneKey(id);
    },

    /** Final. Revoking twice keeps the first time. */
    async revokeKey(id: string): Promise<KeyInfo> {
      const result = await sql`UPDATE api_key SET revoked_at = COALESCE(revoked_at, ${clock()}) WHERE id = ${id}`;
      if (Number(result.count ?? 0) === 0) throw new NotFoundError(`no API key ${id}`);
      return oneKey(id);
    },

    async keyUsage(id: string, opts: { days: number }): Promise<UsageDay[]> {
      await oneKey(id);
      const from = utcDay(new Date(clock().getTime() - (Math.max(1, opts.days) - 1) * DAY_MS));
      const rows = (await sql`
        SELECT day, answered, invalid, limited FROM api_usage_daily
        WHERE key_id = ${id} AND day >= ${from}::date ORDER BY day`) as { day: unknown; answered: number; invalid: number; limited: number }[];
      return rows.map((r) => ({ day: dayText(r.day), answered: r.answered, invalid: r.invalid, limited: r.limited }));
    },

    /** Keys the API accepts now (research R3): not revoked, account not disabled. */
    async activeKeys(): Promise<ActiveKey[]> {
      const rows = (await sql`
        SELECT k.id, k.secret_sha256, k.daily_quota, k.burst
        FROM api_key k JOIN account a ON a.id = k.account_id
        WHERE k.revoked_at IS NULL AND a.disabled_at IS NULL`) as { id: string; secret_sha256: Uint8Array; daily_quota: number | null; burst: number | null }[];
      return rows.map((r) => ({
        id: r.id, sha256: new Uint8Array(r.secret_sha256), dailyQuota: r.daily_quota ?? defaults.dailyQuota, burst: r.burst ?? defaults.burst,
      }));
    },

    /** Answered lookups per key on one UTC day, to seed the daily counters (research R4). */
    async answeredOn(day: string): Promise<Map<string, number>> {
      const rows = (await sql`SELECT key_id, answered FROM api_usage_daily WHERE day = ${day}::date`) as { key_id: string; answered: number }[];
      return new Map(rows.map((r) => [r.key_id, r.answered]));
    },

    /** Adds usage increments in one transaction (research R5). */
    async addUsage(increments: UsageIncrement[]): Promise<void> {
      if (increments.length === 0) return;
      await sql.begin(async (tx) => {
        for (const u of increments) {
          await tx`
            INSERT INTO api_usage_daily (key_id, day, answered, invalid, limited)
            VALUES (${u.keyId}, ${u.day}::date, ${u.answered}, ${u.invalid}, ${u.limited})
            ON CONFLICT (key_id, day) DO UPDATE SET
              answered = api_usage_daily.answered + EXCLUDED.answered,
              invalid = api_usage_daily.invalid + EXCLUDED.invalid,
              limited = api_usage_daily.limited + EXCLUDED.limited`;
          if (u.lastUsedAt) {
            await tx`UPDATE api_key SET last_used_at = GREATEST(COALESCE(last_used_at, ${u.lastUsedAt}), ${u.lastUsedAt}) WHERE id = ${u.keyId}`;
          }
        }
      });
    },

    /** Deletes usage rows older than `days` (research R5: 400). */
    async pruneUsage(days: number): Promise<number> {
      const cutoff = utcDay(new Date(clock().getTime() - days * DAY_MS));
      const result = await sql`DELETE FROM api_usage_daily WHERE day < ${cutoff}::date`;
      return Number(result.count ?? 0);
    },
  };
}

export type Accounts = ReturnType<typeof createAccounts>;
