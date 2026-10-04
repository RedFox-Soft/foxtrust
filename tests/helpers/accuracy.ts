import { join } from "node:path";
import { DEFAULT_KNOWN_GOOD } from "../../src/eval/known-good";
import type { SeedRows } from "./seed";

type Sighting = NonNullable<SeedRows["sightings"]>[number];
type Category = NonNullable<SeedRows["categories"]>[number];

const DAY = 86_400_000;

/** ISO time `days` before `from` (default now); fractional days are fine. */
export const isoDaysAgo = (days: number, from = new Date()): string => new Date(from.getTime() - days * DAY).toISOString();

/**
 * Writes a valid known-good reference to `dir`: the shipped reference plus `extra` rows
 * (`ip,reason,source,added` lines), and returns its path.
 */
export async function knownGoodFile(dir: string, extra: string[] = [], name = "known-good.csv"): Promise<string> {
  const base = (await Bun.file(DEFAULT_KNOWN_GOOD).text()).trimEnd();
  const path = join(dir, name);
  await Bun.write(path, `${[base, ...extra].join("\n")}\n`);
  return path;
}

/** A behavior sighting row for `seedRows`. Local-only (`shippable: false`) unless stated. */
export function behaviorSighting(s: {
  prefix: string;
  source: string;
  code: string;
  recordedAt: string;
  lastSeen?: string;
  firstSeen?: string;
  shippable?: boolean;
  open?: boolean;
  confidence?: number | null;
}): Sighting {
  return {
    prefix: s.prefix,
    source: s.source,
    code: s.code,
    firstSeen: s.firstSeen ?? s.recordedAt,
    lastSeen: s.lastSeen ?? s.recordedAt,
    recordedAt: s.recordedAt,
    open: s.open ?? true,
    confidence: s.confidence ?? null,
    shippable: s.shippable ?? false,
  };
}

/** A category interval row for `seedRows`, open-ended and shippable unless stated. */
export function category(c: { prefix: string; code: string; source: string; from: string; lastSeen?: string; to?: string | null; shippable?: boolean }): Category {
  return { prefix: c.prefix, code: c.code, source: c.source, from: c.from, to: c.to ?? null, lastSeen: c.lastSeen ?? c.from, shippable: c.shippable ?? true };
}
