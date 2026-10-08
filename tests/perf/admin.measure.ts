import { signIn, startTestAdmin } from "../helpers/admin";
import { startFakeOidc } from "../helpers/oidc";
import { tempDb, type Measurement } from "./util";

const KEYS = 10_000;
const DAYS = 365;
const RUNS = 5;

/** Spec 011 SC-005: the overview, the key list and a key's page in under 1 s with 10,000 keys and a year of usage. */
export async function measureAdmin(): Promise<Measurement[]> {
  const db = await tempDb("bench_admin");
  const oidc = await startFakeOidc();
  try {
    const now = new Date();
    const iso = now.toISOString();
    const today = iso.slice(0, 10);
    await db.sql`INSERT INTO account (id, name, contact, created_at) VALUES ('acc_bench000000', 'Bench', 'bench@example.com', ${now})`;
    await db.sql`
      INSERT INTO api_key (id, account_id, label, secret_sha256, created_at)
      SELECT lpad(i::text, 12, '0'), 'acc_bench000000', 'k' || i, sha256(i::text::bytea), ${iso}::timestamptz - (i || ' minutes')::interval
      FROM generate_series(1, ${KEYS}) AS i`;
    await db.sql`
      INSERT INTO api_usage_daily (key_id, day, answered, invalid, limited)
      SELECT '000000000001', (${today}::date - d), 900, 5, 2 FROM generate_series(0, ${DAYS - 1}) AS d`;
    // Recent usage for every key, as a busy week would leave.
    await db.sql`
      INSERT INTO api_usage_daily (key_id, day, answered) SELECT id, ${today}::date, 10 FROM api_key ON CONFLICT DO NOTHING`;

    const admin = await startTestAdmin({ sql: db.sql, oidc });
    try {
      const op = (await signIn(admin, oidc)).browser;
      const out: Measurement[] = [];
      for (const path of ["/", "/keys", "/keys/000000000001", "/accounts/acc_bench000000"]) {
        await (await op.get(path)).text(); // warm-up
        const times: number[] = [];
        for (let i = 0; i < RUNS; i++) {
          const t = performance.now();
          const res = await op.get(path);
          await res.text();
          if (res.status !== 200) throw new Error(`${path}: ${res.status}`);
          times.push(performance.now() - t);
        }
        const worst = Math.max(...times);
        out.push({ criterion: `011 SC-005 ${path} (${KEYS} keys, ${DAYS} days)`, target: "< 1000 ms", measured: `worst ${worst.toFixed(0)} ms of ${RUNS}`, pass: worst < 1000 });
      }
      return out;
    } finally {
      await admin.stop();
    }
  } finally {
    await oidc.stop();
    await db.drop();
  }
}
