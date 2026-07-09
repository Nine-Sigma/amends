import { describe, expect, it } from 'vitest';

import { parseAdapterResult } from './parse-result.js';

const conformant = (): Record<string, unknown> => ({
  branch_ref: 'amends/fix-1301',
  fix_diff_path: '.amends/fix.diff',
  artifact_paths: ['src/pay.counterfactual.test.ts'],
  usage: { input_tokens: 100, output_tokens: 20, estimated_usd: 0.01, usage_source: 'reported' },
});

describe('parseAdapterResult', () => {
  it('accepts a conformant body and preserves unmodeled fields (tolerant reader)', () => {
    const input = { ...conformant(), agent_notes: 'extra' };

    const outcome = parseAdapterResult(input);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.body['agent_notes']).toBe('extra');
  });

  it('rejects a non-object input at the root', () => {
    const outcome = parseAdapterResult('a string');

    expect(outcome).toEqual({ ok: false, errors: [{ path: '$', reason: 'expected an object' }] });
  });

  it.each(['branch_ref', 'fix_diff_path', 'artifact_paths', 'usage'])(
    'rejects a body missing %s with an error at that path',
    (field) => {
      const input = conformant();
      delete input[field];

      const outcome = parseAdapterResult(input);

      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      expect(outcome.errors).toContainEqual({ path: field, reason: 'required field is missing' });
    },
  );

  it('accepts null usage figures under usage_source unavailable (usage honesty)', () => {
    const input = conformant();
    input['usage'] = { input_tokens: null, output_tokens: null, estimated_usd: null, usage_source: 'unavailable' };

    expect(parseAdapterResult(input).ok).toBe(true);
  });

  it('rejects a usage_source outside the closed registry', () => {
    const input = conformant();
    input['usage'] = { ...(input['usage'] as object), usage_source: 'vibes' };

    const outcome = parseAdapterResult(input);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.errors).toContainEqual({
      path: 'usage.usage_source',
      reason: "expected one of 'reported' | 'estimated' | 'unavailable'",
    });
  });

  it('rejects mistyped usage figures naming each offending path', () => {
    const input = conformant();
    input['usage'] = { input_tokens: 'many', output_tokens: 20, estimated_usd: 0.01, usage_source: 'reported' };

    const outcome = parseAdapterResult(input);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.errors).toEqual([
      { path: 'usage.input_tokens', reason: 'expected a number or null' },
    ]);
  });
});
