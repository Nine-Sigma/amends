/**
 * The pipeline result taxonomy (§7.2): success plus every gate refusal as a
 * distinct discriminated-union member. Tier 0 behavior is total — every path
 * where the evidence gate is unmet exits structured and opens nothing.
 */

import type { OpenPrResult } from '../pr/open-pr.js';
import type { CounterfactualVerdict } from '../verification/counterfactual.js';

/** §5.4: an unresolved release resolution excludes every code-change-PR path. */
export interface ReleaseUnresolved {
  kind: 'release_unresolved';
  declared: string;
}

/** The evidence gate cannot even run: `missing` lists what was absent. */
export interface EvidenceGateUnmet {
  kind: 'evidence_gate_unmet';
  missing: string[];
}

/** Refusals the verify stage emits before any verification run executes. */
export type PreRunRefusal = ReleaseUnresolved | EvidenceGateUnmet;

/** Everything the verify stage can serialize into the handoff bundle. */
export type PipelineVerdict = CounterfactualVerdict | PreRunRefusal;

export type PipelineRefusal =
  | PreRunRefusal
  | Exclude<CounterfactualVerdict, { kind: 'counterfactual' }>;

export type PipelineResult = { kind: 'published'; outcome: OpenPrResult } | PipelineRefusal;

const assertNever = (value: never): never => {
  throw new Error(`unhandled pipeline result: ${JSON.stringify(value)}`);
};

const guardrailSummary = (violation: Extract<PipelineRefusal, { kind: 'guardrail_violation' }>['violation']): string => {
  switch (violation.kind) {
    case 'hard_blocked':
      return `fix diff touches hard-blocked paths: ${violation.paths.join(', ')}`;
    case 'invariance':
      return `fix diff touches verification configuration: ${violation.paths.join(', ')}`;
    case 'unenumerable_diff':
      return `fix diff paths could not be enumerated: ${violation.reason}`;
    default:
      return assertNever(violation);
  }
};

/** The exhaustive switch is the compile-time proof that no result arm is unhandled. */
export const summarizePipelineResult = (result: PipelineResult): string => {
  switch (result.kind) {
    case 'published':
      return `opened evidence-backed pull request: ${result.outcome.kind}`;
    case 'evidence_gate_unmet':
      return `evidence gate unmet, missing: ${result.missing.join(', ')}`;
    case 'not_counterfactual':
      return 'artifact passed on the original revision; nothing was validated';
    case 'fix_insufficient':
      return `artifact still fails on the patched revision: ${result.reasons.join(', ')}`;
    case 'guardrail_violation':
      return guardrailSummary(result.violation);
    case 'cap_exceeded':
      return `fix diff changes ${String(result.fileCount)} files, limit is ${String(result.limit)}`;
    case 'release_unresolved':
      return `release resolution is unresolved for declared release ${result.declared}; no code-change PR path`;
    default:
      return assertNever(result);
  }
};
