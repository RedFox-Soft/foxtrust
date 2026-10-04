import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluate } from "../../src/eval/evaluate";
import { loadKnownGood } from "../../src/eval/known-good";
import { dataLabel, loadStage2Data } from "./stage2-data";
import { tempDb, type Measurement } from "./util";

/**
 * Spec 003 SC-006: a full evaluation (known-good reference, known-bad sample, early detection and
 * feed contribution) under 5 minutes. With BENCH_FEED_DIR the stage 2 data is full size.
 */
export async function measureAccuracyEvaluation(): Promise<Measurement[]> {
  const db = await tempDb("bench_accuracy");
  const artifacts = await mkdtemp(join(tmpdir(), "foxtrust-bench-accuracy-"));
  try {
    await loadStage2Data(db.sql, artifacts);
    const knownGood = await loadKnownGood();
    const started = performance.now();
    const report = await evaluate(db.sql, { knownGood, contribution: { perFeed: 1000 } });
    const seconds = (performance.now() - started) / 1000;
    const sampled = Object.values(report.sample.byFeed).reduce((n, b) => n + b.size, 0);
    const contributions = report.configs[0]!.contribution!.reduce((n, r) => n + r.sampled, 0);
    return [
      {
        criterion: `spec 003 SC-006 full eval --contribution (${dataLabel()})`,
        target: "< 300 s",
        measured: `${seconds.toFixed(1)} s (${knownGood.entries.length} known-good, ${sampled} sampled, ${contributions} contribution entries)`,
        pass: seconds < 300,
      },
    ];
  } finally {
    await db.drop();
    await rm(artifacts, { recursive: true, force: true });
  }
}
