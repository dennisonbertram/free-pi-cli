// The one semver comparator in the codebase (plan #37: "compareVersions
// exists in ONE place"). Both the server's completions gate and the CLI's
// startup check import this — no second copy anywhere.

/**
 * Compares two `X.Y.Z`-shaped version strings on their first three numeric
 * parts. Returns -1/0/1, or `null` if either string has a missing or
 * non-numeric part (malformed input) — callers treat `null` as "can't
 * compare, don't act" rather than guessing.
 */
export function compareVersions(a: string, b: string): -1 | 0 | 1 | null {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  if (pa.length < 3 || pb.length < 3) return null;
  for (let i = 0; i < 3; i++) {
    if (Number.isNaN(pa[i]) || Number.isNaN(pb[i])) return null;
    if (pa[i]! < pb[i]!) return -1;
    if (pa[i]! > pb[i]!) return 1;
  }
  return 0;
}
