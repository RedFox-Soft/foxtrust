/** FR-017: an update with fewer than half the previous entries is held back as suspicious. */
export function shrinkGuard(previousCount: number | null | undefined, nextCount: number): "pass" | "hold" {
  if (!previousCount) return "pass";
  return nextCount < 0.5 * previousCount ? "hold" : "pass";
}
