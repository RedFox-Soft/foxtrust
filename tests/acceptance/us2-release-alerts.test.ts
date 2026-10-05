import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { releaseDeriver } from "../../src/alerts/derive";
import { createAlertTick } from "../../src/alerts/reconcile";
import { activateConfig } from "../../src/db/versions";
import { describeDb, resetData, withTestDb } from "../helpers/db";
import { startFakeTelegram, settingsFor, type FakeTelegram } from "../helpers/fake-telegram";
import { shippedConfig } from "../helpers/seed";

const HOUR = 3_600_000;

describeDb("US2 (spec 004): release problems reach the operator", () => {
  const db = withTestDb();
  let fake: FakeTelegram;
  let tmp: string;
  let dataVersion: number;

  // The rows buildAndRelease writes for a held, rejected or published release (spec 002, FR-012a).
  const release = (r: { version: string; kind: "full" | "delta"; status: string; builtAt: Date; reportPath?: string; error?: string }) =>
    db.sql`
      INSERT INTO snapshot_release (version, kind, base_version, data_version_id, algorithm_version, config_sha256,
                                    built_at, status, report_path, error)
      VALUES (${r.version}, ${r.kind}, ${r.kind === "delta" ? "f20261005" : null}, ${dataVersion}, 'noisy-or/1', 'test',
              ${r.builtAt}, ${r.status}, ${r.reportPath ?? null}, ${r.error ?? null})`;
  const tickAt = (now: Date) =>
    createAlertTick({
      sql: db.sql, settings: settingsFor(fake), startedAt: now, log: () => {}, derivers: [releaseDeriver],
      now: () => now, timeoutMs: 2_000,
    })();

  beforeAll(async () => {
    fake = startFakeTelegram();
    tmp = await mkdtemp(join(tmpdir(), "foxtrust-004-us2-"));
  });
  afterAll(async () => {
    await fake.stop();
    await rm(tmp, { recursive: true, force: true });
  });
  beforeEach(async () => {
    await resetData(db.sql);
    await db.sql`TRUNCATE snapshot_release RESTART IDENTITY`;
    dataVersion = (await activateConfig(db.sql, await shippedConfig())).id;
    await fake.reset();
  });

  test("US2-1: a held release produces one message with version, kind, regressions, report and the publish command", async () => {
    const reportPath = join(tmp, "f20261006.report.json");
    await Bun.write(reportPath, JSON.stringify({ regressions: ["FP rate at medium rose by 0.6 pp (limit 0.5 pp)"] }));
    await release({ version: "f20261006", kind: "full", status: "held", builtAt: new Date(), reportPath });

    await tickAt(new Date());
    const texts = fake.accepted();
    expect(texts).toHaveLength(1);
    expect(texts[0]).toContain("⚠️ Release f20261006 (full) held by the regression gate:");
    expect(texts[0]).toContain("· FP rate at medium rose by 0.6 pp (limit 0.5 pp)");
    expect(texts[0]).toContain(`Report: ${reportPath}`);
    expect(texts[0]).toContain('→ foxtrust snapshot publish f20261006 --release-note "<why>"');
  });

  test("US2-2: a release rejected by validation produces one message with its problems", async () => {
    await release({
      version: "d20261006T09", kind: "delta", status: "rejected", builtAt: new Date(),
      error: "file does not read back with the MMDB reader\nsize 260 MB exceeds the 250 MB budget",
    });

    await tickAt(new Date());
    const texts = fake.accepted();
    expect(texts).toHaveLength(1);
    expect(texts[0]).toContain("⚠️ Release d20261006T09 (delta) rejected:");
    expect(texts[0]).toContain("· file does not read back with the MMDB reader");
    expect(texts[0]).toContain("· size 260 MB exceeds the 250 MB budget");
  });

  test("US2-3: a later published release of the same kind produces one recovery message naming it", async () => {
    const t0 = new Date();
    await release({ version: "f20261006", kind: "full", status: "held", builtAt: t0 });
    await tickAt(t0);
    await release({ version: "f20261007", kind: "full", status: "published", builtAt: new Date(t0.getTime() + HOUR) });

    await tickAt(new Date(t0.getTime() + HOUR));
    const texts = fake.accepted();
    expect(texts).toHaveLength(2);
    expect(texts[1]).toContain("✅ Resolved after 1 h: full release f20261007 published");
  });

  test("US2-4: consecutive held deltas stay one problem; the daily reminder shows the latest version", async () => {
    const t0 = new Date();
    await release({ version: "d20261006T09", kind: "delta", status: "held", builtAt: t0 });
    await tickAt(t0);
    for (const h of [1, 2]) {
      await release({ version: `d20261006T${9 + h}`, kind: "delta", status: "held", builtAt: new Date(t0.getTime() + h * HOUR) });
      await tickAt(new Date(t0.getTime() + h * HOUR));
    }
    expect(fake.accepted()).toHaveLength(1);

    await tickAt(new Date(t0.getTime() + 24 * HOUR));
    const texts = fake.accepted();
    expect(texts).toHaveLength(2);
    expect(texts[1]).toContain("⏰ Still open after 1 d:");
    expect(texts[1]).toContain("Release d20261006T11 (delta) held by the regression gate:");
    expect(texts[1]).not.toContain("d20261006T09");
  });
});
