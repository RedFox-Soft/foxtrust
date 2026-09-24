const HOUR_MS = 3_600_000;

/** Age in hours at `at`. A `lastSeen` after `at` (clock skew in a feed) counts as age 0. */
export function ageHours(lastSeen: Date, at: Date): number {
  return Math.max(0, (at.getTime() - lastSeen.getTime()) / HOUR_MS);
}

/** FR-007: 0.5 ^ (ageHours / halfLifeHours). No half-life (category signals) means no decay. */
export function decay(lastSeen: Date, at: Date, halfLifeHours?: number): number {
  if (halfLifeHours === undefined) return 1;
  return 0.5 ** (ageHours(lastSeen, at) / halfLifeHours);
}
