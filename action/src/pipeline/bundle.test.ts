import { describe, expect, it } from 'vitest';

import { parseFixBundle, parseVerifyBundle } from './bundle.js';
import type { FixBundle, VerifyBundle } from './bundle.js';

const validFixBundle = (): FixBundle => ({
  fixDiff: 'diff --git a/src/total.js b/src/total.js\n',
  artifactFiles: { 'artifact.test.mjs': 'assert.equal(1, 1);' },
  adapterResult: {
    branch_ref: 'amends/fix-happy-tier1',
    fix_diff_path: 'amends-out/fix.patch',
    artifact_paths: ['artifact.test.mjs'],
    usage: { input_tokens: 1, output_tokens: 2, estimated_usd: 0.01, usage_source: 'reported' },
    exit_code: 0,
  },
  agentIdentity: { agent: 'fake-adapter', model: 'fake-model' },
});

const roundTrip = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

describe('parseFixBundle', () => {
  it('accepts a serialized round-trip of a valid bundle', () => {
    const result = parseFixBundle(roundTrip(validFixBundle()));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.bundle.agentIdentity.model).toBe('fake-model');
    }
  });

  it('rejects a missing fixDiff naming the path', () => {
    const bundle = roundTrip(validFixBundle()) as Record<string, unknown>;
    delete bundle['fixDiff'];
    const result = parseFixBundle(bundle);
    expect(result).toEqual({
      ok: false,
      errors: [{ path: 'fixDiff', reason: 'required field is missing' }],
    });
  });

  it('rejects a non-string artifact file content naming the entry', () => {
    const bundle: Record<string, unknown> = roundTrip(validFixBundle()) as Record<string, unknown>;
    bundle['artifactFiles'] = { 'artifact.test.mjs': 42 };
    const result = parseFixBundle(bundle);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContainEqual({
        path: 'artifactFiles.artifact.test.mjs',
        reason: 'expected a string',
      });
    }
  });

  it('rejects an adapter result missing its usage block at the prefixed path', () => {
    const bundle = roundTrip(validFixBundle()) as { adapterResult: Record<string, unknown> };
    delete bundle.adapterResult['usage'];
    const result = parseFixBundle(bundle);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContainEqual({
        path: 'adapterResult.usage',
        reason: 'required field is missing',
      });
    }
  });
});

const counterfactualVerifyBundle = (): VerifyBundle => ({
  verdict: {
    kind: 'counterfactual',
    observation: {
      runner: 'node',
      artifactPaths: ['artifact.test.mjs'],
      serverProcessSpawned: false,
      httpExercised: false,
      browserExercised: false,
      dataPath: 'fixture-only',
      originalRun: { passed: false, failureSignature: 'exit 1: boom' },
      patchedRun: { passed: true },
    },
  },
});

describe('parseVerifyBundle', () => {
  it('accepts a serialized round-trip of a counterfactual verdict', () => {
    const result = parseVerifyBundle(roundTrip(counterfactualVerifyBundle()));
    expect(result.ok).toBe(true);
    if (result.ok && result.bundle.verdict.kind === 'counterfactual') {
      expect(result.bundle.verdict.observation.patchedRun.passed).toBe(true);
    }
  });

  it.each([
    { verdict: { kind: 'not_counterfactual', originalRun: { passed: true } } },
    {
      verdict: {
        kind: 'guardrail_violation',
        violation: { kind: 'hard_blocked', paths: ['.github/workflows/release.yml'] },
      },
    },
    { verdict: { kind: 'cap_exceeded', fileCount: 11, limit: 10 } },
    { verdict: { kind: 'evidence_gate_unmet', missing: ['counterfactual_artifact'] } },
    { verdict: { kind: 'release_unresolved', declared: 'api@2.1.0' } },
  ])('accepts the refusal verdict $verdict.kind', (bundle) => {
    expect(parseVerifyBundle(roundTrip(bundle)).ok).toBe(true);
  });

  it('rejects an evidence_gate_unmet verdict missing its missing list', () => {
    const result = parseVerifyBundle({ verdict: { kind: 'evidence_gate_unmet' } });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContainEqual({
        path: 'verdict.missing',
        reason: 'required field is missing',
      });
    }
  });

  it('rejects a release_unresolved verdict missing declared', () => {
    const result = parseVerifyBundle({ verdict: { kind: 'release_unresolved' } });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContainEqual({
        path: 'verdict.declared',
        reason: 'required field is missing',
      });
    }
  });

  it('rejects an unknown verdict kind at verdict.kind', () => {
    const result = parseVerifyBundle({ verdict: { kind: 'definitely_fine' } });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]?.path).toBe('verdict.kind');
    }
  });

  it('rejects a failed run outcome missing its failure signature', () => {
    const bundle = roundTrip(counterfactualVerifyBundle()) as {
      verdict: { observation: { originalRun: Record<string, unknown> } };
    };
    delete bundle.verdict.observation.originalRun['failureSignature'];
    const result = parseVerifyBundle(bundle);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContainEqual({
        path: 'verdict.observation.originalRun.failureSignature',
        reason: 'required field is missing',
      });
    }
  });

  it('rejects a not_counterfactual verdict missing originalRun', () => {
    const result = parseVerifyBundle({ verdict: { kind: 'not_counterfactual' } });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContainEqual({
        path: 'verdict.originalRun',
        reason: 'required field is missing',
      });
    }
  });
});
