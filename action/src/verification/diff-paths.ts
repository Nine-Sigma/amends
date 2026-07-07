/**
 * Paths a unified diff touches, derived mechanically from the diff text
 * itself. Guardrails must judge what `git apply` will actually do, so an
 * adapter-declared path list is never trusted here (observed-over-claimed,
 * §8.1) — the diff content is the single source for both apply and checks.
 */

const DIFF_HEADER = /^diff --git a\/(.+) b\/(.+)$/;

export function parseFixDiffPaths(fixDiff: string): string[] {
  const paths = new Set<string>();
  for (const line of fixDiff.split('\n')) {
    const match = DIFF_HEADER.exec(line);
    if (!match) continue;
    const [, aPath, bPath] = match;
    if (aPath !== undefined) paths.add(aPath);
    if (bPath !== undefined) paths.add(bPath);
  }
  return [...paths];
}
