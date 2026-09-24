import { beforeEach, expect, test } from "bun:test";
import Ajv2020 from "ajv/dist/2020";
import scenarios from "../fixtures/scenarios.json";
import verdictSchema from "../../schemas/verdict.schema.json";
import { createIpTrust } from "../../src/lookup/lookup";
import type { LookupOptions, ScoringConfig, Verdict } from "../../src/model/types";
import { describeDb, resetData, withTestDb } from "../helpers/db";
import { seedDataVersion, seedConfig, seedRows, shippedConfig, type SeedRows } from "../helpers/seed";

type Case = {
  scenario: string;
  name: string;
  family: 4 | 6;
  seed: SeedRows;
  ip: string;
  at?: string;
  options?: { excludeSources?: string[] };
  configPatch?: { sourceConfidence?: Record<string, number> };
  expected: Partial<Verdict> & Record<string, unknown>;
};

const NOW = new Date(scenarios.defaults.now);
const clock = () => NOW;
const validateVerdict = new Ajv2020({ validateFormats: false, multipleOfPrecision: 6 }).compile(verdictSchema);

function expectValidVerdict(verdict: Verdict): void {
  if (!validateVerdict(verdict)) throw new Error(`verdict violates schema: ${JSON.stringify(validateVerdict.errors)}`);
  const sum = verdict.reasons.reduce((a, r) => a + r.contribution, 0);
  expect(Math.round(sum * 10) / 10).toBe(verdict.risk); // SC-002: contributions add up to the risk
  if (verdict.risk > 0) expect(verdict.reasons.length).toBeGreaterThan(0);
}

async function configFor(c: Case): Promise<ScoringConfig> {
  const base = await shippedConfig();
  if (!c.configPatch) return base;
  return {
    ...base,
    version: "2026-09-24.2",
    sourceConfidence: { ...base.sourceConfidence, ...c.configPatch.sourceConfidence },
  };
}

describeDb("US1: explainable verdict for an address", () => {
  const db = withTestDb();
  beforeEach(() => resetData(db.sql));

  const cases = scenarios.cases as unknown as Case[];
  for (const c of cases) {
    test(`${c.scenario}: ${c.name} (IPv${c.family})`, async () => {
      const seed: SeedRows = { versions: scenarios.defaults.versions, ...c.seed };
      await seedRows(db.sql, seed, await configFor(c));

      const client = createIpTrust({ databaseUrl: db.url, clock });
      try {
        const options: LookupOptions = { at: new Date(c.at ?? scenarios.defaults.at) };
        if (c.options?.excludeSources) options.excludeSources = c.options.excludeSources;
        const result = await client.lookup(c.ip, options);
        if (!result.ok) throw new Error(`lookup failed: ${JSON.stringify(result.error)}`);

        expect(result.verdict).toMatchObject(c.expected);
        expect(result.verdict.dataVersion).toMatch(/^dv\d+\.noisy-or\/1\.[0-9a-f]{8}$/);
        expectValidVerdict(result.verdict);

        // US1-6 applies to every case: the same data and evaluation time give identical verdicts.
        const again = await client.lookup(c.ip, options);
        expect(again).toEqual(result);
      } finally {
        await client.close();
      }
    });
  }

  for (const family of [4, 6] as const) {
    test(`US1-6: a lookup during an uncommitted update sees exactly one data version (IPv${family})`, async () => {
      const ip = family === 4 ? "185.220.101.9" : "2a0b:f4c2:2::9";
      const prefix = family === 4 ? "185.220.101.9/32" : "2a0b:f4c2:2::9/128";
      const config = await seedConfig(db.sql);
      await seedDataVersion(db.sql, "2026-08-01T00:00:00Z", config);
      const client = createIpTrust({ databaseUrl: db.url, clock });
      const at = new Date("2030-01-01T00:00:00Z"); // after both versions

      try {
        const before = await client.lookup(ip, { at });
        let release!: () => void;
        const gate = new Promise<void>((resolve) => (release = resolve));
        let inserted!: () => void;
        const written = new Promise<void>((resolve) => (inserted = resolve));

        const writer = db.sql.begin(async (tx) => {
          await tx`INSERT INTO feed (id) VALUES ('tor-exit') ON CONFLICT DO NOTHING`;
          const [run] = await tx`
            INSERT INTO feed_run (feed_id, started_at, status, committed_at)
            VALUES ('tor-exit', now(), 'applied', now()) RETURNING id`;
          await tx`
            INSERT INTO category_interval (prefix, code, source, valid, last_seen, opened_run_id, shippable)
            VALUES (${prefix}::cidr, 'tor_exit', 'tor-exit', tstzrange(now(), NULL, '[)'), now(), ${run.id}, true)`;
          await seedDataVersion(tx, new Date().toISOString(), config, "feed_run");
          inserted();
          await gate;
        });

        await written;
        const during = await client.lookup(ip, { at });
        release();
        await writer;
        const after = await client.lookup(ip, { at });

        if (!before.ok || !during.ok || !after.ok) throw new Error("lookup failed");
        expect(during.verdict).toEqual(before.verdict);
        expect(during.verdict.reasons).toHaveLength(0);
        expect(after.verdict.dataVersion).not.toBe(before.verdict.dataVersion);
        expect(after.verdict.reasons.map((r) => r.code)).toEqual(["tor_exit"]);
      } finally {
        await client.close();
      }
    });
  }

  for (const input of scenarios.invalid.inputs) {
    test(`US1-7: invalid input ${JSON.stringify(input)} returns a validation error and no verdict`, async () => {
      const client = createIpTrust({ databaseUrl: db.url, clock });
      try {
        const result = await client.lookup(input);
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.code).toBe("invalid_ip");
          expect(result.error.message.length).toBeGreaterThan(0);
        }
      } finally {
        await client.close();
      }
    });
  }

  test("US1-7: the CLI rejects invalid input with exit code 2 and a message", async () => {
    const proc = Bun.spawn(["bun", "run", "src/cli/main.ts", "lookup", "010.0.0.1"], {
      env: { ...Bun.env, DATABASE_URL: db.url },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await proc.exited).toBe(2);
    expect(await new Response(proc.stderr).text()).toContain("leading zeros");
  });

  test("US1-7: an unknown excluded source and a time before any data are errors, not verdicts", async () => {
    await seedRows(db.sql, { versions: scenarios.defaults.versions });
    const client = createIpTrust({ databaseUrl: db.url, clock });
    try {
      const unknown = await client.lookup("8.8.8.8", { excludeSources: ["no-such-feed"] });
      expect(unknown).toMatchObject({ ok: false, error: { code: "unknown_source", source: "no-such-feed" } });
      const early = await client.lookup("8.8.8.8", { at: new Date("2025-01-01T00:00:00Z") });
      expect(early).toMatchObject({ ok: false, error: { code: "no_data" } });
    } finally {
      await client.close();
    }
  });

  for (const family of [4, 6] as const) {
    test(`US1-1: the CLI prints the same verdict as JSON (IPv${family})`, async () => {
      const c = (scenarios.cases as unknown as Case[]).find((x) => x.scenario === "US1-1" && x.family === family)!;
      await seedRows(db.sql, { versions: scenarios.defaults.versions, ...c.seed });
      const proc = Bun.spawn(["bun", "run", "src/cli/main.ts", "lookup", c.ip, "--at", scenarios.defaults.at, "--json"], {
        env: { ...Bun.env, DATABASE_URL: db.url },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(await proc.exited).toBe(0);
      const verdict = JSON.parse(await new Response(proc.stdout).text()) as Verdict;
      expectValidVerdict(verdict);
      expect(verdict).toMatchObject({ ip: c.expected.ip, risk: c.expected.risk, reasons: c.expected.reasons });
    });
  }
});
