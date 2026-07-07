/**
 * Mechanical record of what the verify stage observed while executing the
 * counterfactual artifact (product PRD §7.2). Produced ONLY by the verify
 * stage from observable run properties — no field is ever sourced from
 * adapter self-description, which is untrusted input (§8.1).
 */

export type RunOutcome =
  | { passed: true }
  | { passed: false; failureSignature: string };

export interface VerificationObservation {
  /**
   * Runner the verify stage invoked. Open registry — conventional values:
   * 'vitest', 'jest', 'node', 'playwright', 'cypress', 'tsc', 'typecheck',
   * 'build'. Unknown values are valid and classify conservatively.
   */
  runner: string;
  /** Counterfactual artifact files, separable from the fix diff. */
  artifactPaths: string[];
  serverProcessSpawned: boolean;
  httpExercised: boolean;
  browserExercised: boolean;
  dataPath: 'fixture-only' | 'live-path';
  /** Run against the original revision (expected FAIL). */
  originalRun: RunOutcome;
  /** Run against the patched revision (expected PASS). */
  patchedRun: RunOutcome;
}
