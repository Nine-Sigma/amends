/**
 * Protected-path classification (§8.1). Pure: paths + config in, verdict out.
 * hard_blocked wins over review_required when a diff touches both classes —
 * verification refuses to proceed at all on hard-blocked paths.
 */

import type { AmendsConfig } from '../config/types.js';
import { pathsMatchingAnyGlob } from '../utils/glob.js';

export type DiffClassification =
  | { kind: 'hard_blocked'; paths: string[] }
  /** Caps autonomy at a human-reviewed PR — never auto-merge, regardless of tier (§8.1). */
  | { kind: 'review_required'; paths: string[] }
  | { kind: 'clear' };

export function classifyDiffPaths(
  paths: readonly string[],
  config: AmendsConfig,
): DiffClassification {
  const hardBlocked = pathsMatchingAnyGlob(paths, config.hard_blocked_paths);
  if (hardBlocked.length > 0) return { kind: 'hard_blocked', paths: hardBlocked };

  const reviewRequired = pathsMatchingAnyGlob(paths, config.review_required_paths);
  if (reviewRequired.length > 0) return { kind: 'review_required', paths: reviewRequired };

  return { kind: 'clear' };
}
