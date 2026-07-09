import type { ParseError } from '../utils/narrow.js';
import { isRecord, missingOr, requireOneOf, requireString, requireStringArray } from '../utils/narrow.js';
import type { AdapterResultBody, UsageSource } from './types.js';

export type ParseAdapterResultOutcome =
  | { ok: true; body: AdapterResultBody }
  | { ok: false; errors: ParseError[] };

const USAGE_SOURCES: readonly UsageSource[] = ['reported', 'estimated', 'unavailable'];

const requireNumberOrNull = (
  parent: Record<string, unknown>,
  key: string,
  path: string,
  errors: ParseError[],
): void => {
  const value = parent[key];
  if (typeof value !== 'number' && value !== null) {
    errors.push({ path, reason: missingOr(value, 'a number or null') });
  }
};

const validateUsage = (parent: Record<string, unknown>, errors: ParseError[]): void => {
  const usage = parent['usage'];
  if (!isRecord(usage)) {
    errors.push({ path: 'usage', reason: missingOr(usage, 'an object') });
    return;
  }
  requireNumberOrNull(usage, 'input_tokens', 'usage.input_tokens', errors);
  requireNumberOrNull(usage, 'output_tokens', 'usage.output_tokens', errors);
  requireNumberOrNull(usage, 'estimated_usd', 'usage.estimated_usd', errors);
  requireOneOf(usage, 'usage_source', 'usage.usage_source', USAGE_SOURCES, errors);
};

/**
 * Narrows an adapter's result JSON from unknown (§8.1: adapter output is
 * untrusted). Tolerant reader: unmodeled fields are preserved, never stripped.
 */
export const parseAdapterResult = (input: unknown): ParseAdapterResultOutcome => {
  const errors: ParseError[] = [];
  if (!isRecord(input)) {
    return { ok: false, errors: [{ path: '$', reason: missingOr(input, 'an object') }] };
  }
  requireString(input, 'branch_ref', 'branch_ref', errors);
  requireString(input, 'fix_diff_path', 'fix_diff_path', errors);
  requireStringArray(input, 'artifact_paths', 'artifact_paths', errors);
  validateUsage(input, errors);
  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, body: input as AdapterResultBody };
};
