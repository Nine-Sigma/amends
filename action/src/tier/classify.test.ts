import { describe, expect, it } from 'vitest';

import type { VerificationObservation } from '../verification/observation.js';
import { classifyTier } from './classify.js';

const baseObservation = (
  overrides: Partial<VerificationObservation> = {},
): VerificationObservation => ({
  runner: 'vitest',
  artifactPaths: ['src/checkout/total.counterfactual.test.ts'],
  serverProcessSpawned: false,
  httpExercised: false,
  browserExercised: false,
  dataPath: 'fixture-only',
  originalRun: { passed: false, failureSignature: 'AssertionError: expected 3 to be 2' },
  patchedRun: { passed: true },
  ...overrides,
});

describe('classifyTier', () => {
  it('classifies a build/typecheck-only reproduction as Tier 1 even when the adapter result claims integration', () => {
    const smuggledAdapterClaims = {
      ...baseObservation({ runner: 'tsc', artifactPaths: ['src/checkout/total.repro.ts'] }),
      adapter_claimed_tier: 'integration',
      claimed_evidence_strength: 'integration',
    };

    const result = classifyTier(smuggledAdapterClaims);

    expect(result.tier).toBe(1);
    expect(result.reasons).toContain('build_typecheck_repro_capped_at_tier_1');
  });

  it('classifies Tier 0 with a machine-readable reason when there is no counterfactual artifact', () => {
    const result = classifyTier(baseObservation({ artifactPaths: [] }));

    expect(result.tier).toBe(0);
    expect(result.reasons).toEqual(['no_counterfactual_artifact']);
  });

  it('Tier 0 wins even when strong signals are present without an artifact', () => {
    const result = classifyTier(
      baseObservation({ artifactPaths: [], browserExercised: true, serverProcessSpawned: true }),
    );

    expect(result.tier).toBe(0);
  });

  it('classifies a unit runner with fixture-only data as Tier 1', () => {
    const result = classifyTier(baseObservation());

    expect(result.tier).toBe(1);
    expect(result.reasons.length).toBeGreaterThan(0);
  });

  it('classifies a browser/user-flow run as Tier 2', () => {
    const result = classifyTier(baseObservation({ browserExercised: true }));

    expect(result.tier).toBe(2);
    expect(result.reasons).toContain('browser_context_exercised');
  });

  it('classifies an API replay against a spawned server as Tier 2', () => {
    const result = classifyTier(
      baseObservation({ httpExercised: true, serverProcessSpawned: true, dataPath: 'live-path' }),
    );

    expect(result.tier).toBe(2);
    expect(result.reasons).toContain('api_replay_against_spawned_server');
  });

  it('an E2E runner with an observed browser signal classifies Tier 2 via the signal, not the name', () => {
    const result = classifyTier(
      baseObservation({ runner: 'playwright', browserExercised: true }),
    );

    expect(result.tier).toBe(2);
    expect(result.reasons).toEqual(['browser_context_exercised']);
  });

  it('an E2E runner name alone, with no observed signal, classifies Tier 1 — claims never set autonomy', () => {
    const result = classifyTier(baseObservation({ runner: 'playwright' }));

    expect(result.tier).toBe(1);
    expect(result.reasons).not.toContain('e2e_runner_exercised');
  });

  it('HTTP exercise without a spawned server is individually insufficient — Tier 1', () => {
    const result = classifyTier(baseObservation({ httpExercised: true }));

    expect(result.tier).toBe(1);
    expect(result.reasons).toContain('http_exercised_without_spawned_server');
  });

  it('a spawned server without HTTP exercise is individually insufficient — Tier 1', () => {
    const result = classifyTier(baseObservation({ serverProcessSpawned: true }));

    expect(result.tier).toBe(1);
    expect(result.reasons).toContain('server_spawned_without_http_exercise');
  });

  it('hard-caps build/typecheck runners at Tier 1 even alongside strong signals', () => {
    const result = classifyTier(
      baseObservation({ runner: 'typecheck', browserExercised: true, serverProcessSpawned: true }),
    );

    expect(result.tier).toBe(1);
    expect(result.reasons).toContain('build_typecheck_repro_capped_at_tier_1');
  });

  it('an unknown runner string classifies conservatively at Tier 1', () => {
    const result = classifyTier(baseObservation({ runner: 'some-future-runner' }));

    expect(result.tier).toBe(1);
  });
});
