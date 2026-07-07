/**
 * Stage handoff bundles: the explicit serialized boundary between the fix,
 * verify, and publish jobs (artifact upload/download in the reference
 * workflow). Bundles travel between jobs as workflow artifacts, so the
 * reading side narrows them from unknown like any other boundary input.
 * Internal camelCase format — not the §5.1 protocol; the embedded
 * AdapterResult keeps its snake_case wire shape.
 */

import { parseAdapterResult } from '../adapter/parse-result.js';
import type { AdapterResult } from '../adapter/types.js';
import type { AgentIdentity } from '../pr/compose-body.js';
import type { ParseError } from '../utils/narrow.js';
import {
  isRecord,
  missingOr,
  requireBoolean,
  requireNumber,
  requireRecord,
  requireString,
  requireStringArray,
} from '../utils/narrow.js';
import type { CounterfactualVerdict } from '../verification/counterfactual.js';

export interface FixBundle {
  fixDiff: string;
  /** Counterfactual artifact files (repo-relative path -> content), separable from the fix diff. */
  artifactFiles: Record<string, string>;
  adapterResult: AdapterResult;
  /** Audit-trail identity of the adapter that produced the fix (§7.2). */
  agentIdentity: AgentIdentity;
}

export interface VerifyBundle {
  verdict: CounterfactualVerdict;
}

export type ParseFixBundleResult =
  | { ok: true; bundle: FixBundle }
  | { ok: false; errors: ParseError[] };

export type ParseVerifyBundleResult =
  | { ok: true; bundle: VerifyBundle }
  | { ok: false; errors: ParseError[] };

const validateArtifactFiles = (parent: Record<string, unknown>, errors: ParseError[]): void => {
  const files = requireRecord(parent, 'artifactFiles', 'artifactFiles', errors);
  if (files === undefined) return;
  for (const [path, content] of Object.entries(files)) {
    if (typeof content !== 'string') {
      errors.push({ path: `artifactFiles.${path}`, reason: missingOr(content, 'a string') });
    }
  }
};

const validateAdapterResult = (parent: Record<string, unknown>, errors: ParseError[]): void => {
  const result = requireRecord(parent, 'adapterResult', 'adapterResult', errors);
  if (result === undefined) return;
  const parsed = parseAdapterResult(result);
  if (!parsed.ok) {
    errors.push(...parsed.errors.map((error) => ({ ...error, path: `adapterResult.${error.path}` })));
  }
  requireNumber(result, 'exit_code', 'adapterResult.exit_code', errors);
};

const validateAgentIdentity = (parent: Record<string, unknown>, errors: ParseError[]): void => {
  const identity = requireRecord(parent, 'agentIdentity', 'agentIdentity', errors);
  if (identity === undefined) return;
  requireString(identity, 'agent', 'agentIdentity.agent', errors);
  requireString(identity, 'model', 'agentIdentity.model', errors);
};

export const parseFixBundle = (input: unknown): ParseFixBundleResult => {
  const errors: ParseError[] = [];
  if (!isRecord(input)) {
    return { ok: false, errors: [{ path: '$', reason: missingOr(input, 'an object') }] };
  }
  requireString(input, 'fixDiff', 'fixDiff', errors);
  validateArtifactFiles(input, errors);
  validateAdapterResult(input, errors);
  validateAgentIdentity(input, errors);
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, bundle: input as unknown as FixBundle };
};

const validateRunOutcome = (
  parent: Record<string, unknown>,
  key: string,
  path: string,
  errors: ParseError[],
): void => {
  const run = requireRecord(parent, key, path, errors);
  if (run === undefined) return;
  const passed = run['passed'];
  if (typeof passed !== 'boolean') {
    errors.push({ path: `${path}.passed`, reason: missingOr(passed, 'a boolean') });
    return;
  }
  if (!passed) {
    requireString(run, 'failureSignature', `${path}.failureSignature`, errors);
  }
};

const validateObservation = (
  parent: Record<string, unknown>,
  path: string,
  errors: ParseError[],
): void => {
  const observation = requireRecord(parent, 'observation', path, errors);
  if (observation === undefined) return;
  requireString(observation, 'runner', `${path}.runner`, errors);
  requireStringArray(observation, 'artifactPaths', `${path}.artifactPaths`, errors);
  requireBoolean(observation, 'serverProcessSpawned', `${path}.serverProcessSpawned`, errors);
  requireBoolean(observation, 'httpExercised', `${path}.httpExercised`, errors);
  requireBoolean(observation, 'browserExercised', `${path}.browserExercised`, errors);
  const dataPath = observation['dataPath'];
  if (dataPath !== 'fixture-only' && dataPath !== 'live-path') {
    errors.push({
      path: `${path}.dataPath`,
      reason: missingOr(dataPath, "one of 'fixture-only' | 'live-path'"),
    });
  }
  validateRunOutcome(observation, 'originalRun', `${path}.originalRun`, errors);
  validateRunOutcome(observation, 'patchedRun', `${path}.patchedRun`, errors);
};

const validateGuardrailViolation = (
  verdict: Record<string, unknown>,
  errors: ParseError[],
): void => {
  const violation = requireRecord(verdict, 'violation', 'verdict.violation', errors);
  if (violation === undefined) return;
  const kind = violation['kind'];
  if (kind !== 'hard_blocked' && kind !== 'invariance') {
    errors.push({
      path: 'verdict.violation.kind',
      reason: missingOr(kind, "one of 'hard_blocked' | 'invariance'"),
    });
  }
  requireStringArray(violation, 'paths', 'verdict.violation.paths', errors);
};

const validateVerdictArm = (verdict: Record<string, unknown>, errors: ParseError[]): void => {
  switch (verdict['kind']) {
    case 'counterfactual':
      validateObservation(verdict, 'verdict.observation', errors);
      return;
    case 'not_counterfactual':
      validateRunOutcome(verdict, 'originalRun', 'verdict.originalRun', errors);
      return;
    case 'fix_insufficient':
      validateObservation(verdict, 'verdict.observation', errors);
      requireStringArray(verdict, 'reasons', 'verdict.reasons', errors);
      return;
    case 'guardrail_violation':
      validateGuardrailViolation(verdict, errors);
      return;
    case 'cap_exceeded':
      requireNumber(verdict, 'fileCount', 'verdict.fileCount', errors);
      requireNumber(verdict, 'limit', 'verdict.limit', errors);
      return;
    default:
      errors.push({
        path: 'verdict.kind',
        reason: missingOr(
          verdict['kind'],
          "one of 'counterfactual' | 'not_counterfactual' | 'fix_insufficient' | 'guardrail_violation' | 'cap_exceeded'",
        ),
      });
  }
};

export const parseVerifyBundle = (input: unknown): ParseVerifyBundleResult => {
  const errors: ParseError[] = [];
  if (!isRecord(input)) {
    return { ok: false, errors: [{ path: '$', reason: missingOr(input, 'an object') }] };
  }
  const verdict = requireRecord(input, 'verdict', 'verdict', errors);
  if (verdict !== undefined) {
    validateVerdictArm(verdict, errors);
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, bundle: input as unknown as VerifyBundle };
};
