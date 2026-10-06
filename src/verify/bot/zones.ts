import { join } from "node:path";

/** Time zone → country codes (spec 007 research R9), generated from tzdata by scripts/zone-countries.ts. */

export type Zones = Map<string, Set<string>>;

export const ZONES_FILE = join(import.meta.dir, "..", "..", "..", "config", "bot", "zone-countries.tsv");

export function parseZones(text: string): Zones {
  const zones: Zones = new Map();
  for (const line of text.split("\n")) {
    if (line.startsWith("#") || line.trim() === "") continue;
    const [zone, codes = ""] = line.split("\t");
    if (!zone) continue;
    zones.set(zone.trim(), new Set(codes.trim().split(",").filter(Boolean)));
  }
  return zones;
}

export async function loadZones(file = ZONES_FILE): Promise<Zones> {
  return parseZones(await Bun.file(file).text());
}
