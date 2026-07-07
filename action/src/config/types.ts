/**
 * Phase-1 subset of amends.yml (§11). The file is user-controlled repo
 * content, so it crosses the same trust boundary as the case file (§8.1):
 * parsed from unknown, never trusted typed-but-unvalidated. Keys outside
 * this subset (agent, model, triggers, cost_controls, ...) are ignored here.
 */

import type { ParseError } from '../utils/narrow.js';

/**
 * Requested autonomy ceiling (§7.2). The evidence tier can lower the
 * effective autonomy; nothing can raise it above this mode.
 */
export type Mode = 'issue-only' | 'pr' | 'auto-merge';

export interface ConfigLimits {
  max_files_changed: number;
}

export interface AmendsConfig {
  mode: Mode;
  /** §8.1: '.github/workflows/**' and 'amends.yml' are always present — no override can remove them. */
  hard_blocked_paths: string[];
  /** §8.1: caps autonomy at human-reviewed PR; a user list replaces the defaults outright. */
  review_required_paths: string[];
  limits: ConfigLimits;
}

export type LoadConfigResult =
  | { ok: true; config: AmendsConfig }
  | { ok: false; errors: ParseError[] };
