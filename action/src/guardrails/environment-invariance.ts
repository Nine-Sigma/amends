/**
 * Environment-invariance rule (§7.1): the two verification runs may differ
 * only in the fix diff under test. A fix diff touching verification
 * configuration fakes the counterfactual, so it is rejected before any run.
 *
 * Artifact test files are exempt by construction — they are applied to BOTH
 * runs, so only fixDiffPaths are inspected. Lockfiles and package.json are
 * deliberately NOT in this set: dependency changes are legitimate fixes,
 * governed by §8.1 as review_required (see protected-paths.ts).
 */

import { pathsMatchingAnyGlob } from '../utils/glob.js';

export const VERIFICATION_CONFIG_SET: readonly string[] = [
  '.github/workflows/**',
  'amends.yml',
  'tsconfig*.json',
  'vitest.config.*',
  'jest.config.*',
  'playwright.config.*',
  '.nvmrc',
  '.node-version',
  '.tool-versions',
];

export interface DiffPathSets {
  fixDiffPaths: readonly string[];
  artifactPaths: readonly string[];
}

export type InvarianceVerdict =
  | { kind: 'ok' }
  | { kind: 'violation'; paths: string[] };

export function checkInvariance(
  diff: DiffPathSets,
  verificationConfigSet: readonly string[],
): InvarianceVerdict {
  const violations = pathsMatchingAnyGlob(diff.fixDiffPaths, verificationConfigSet);
  if (violations.length > 0) return { kind: 'violation', paths: violations };
  return { kind: 'ok' };
}
