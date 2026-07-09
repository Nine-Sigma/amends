import type { VerificationObservation } from '../verification/observation.js';

export type Tier = 0 | 1 | 2;

export interface TierClassification {
  tier: Tier;
  reasons: string[];
}

/**
 * Runner values (open registry) that identify a static reproduction. The
 * shipped revision built by definition, so a static repro is hard-capped at
 * Tier 1 (product PRD §7.1).
 */
const BUILD_TYPECHECK_RUNNERS = new Set(['tsc', 'typecheck', 'build', 'compile']);

/**
 * Tier 2 keys on observed signals only (PRD §7.1) — never on the runner name,
 * which is repo-owner-claimed case-file text (§8.2). Phase 1 instruments no
 * browser/HTTP/server signal, so Tier 2 is intentionally unreachable until
 * real instrumentation exists.
 */
const strongTier2Signals = (observation: VerificationObservation): string[] => {
  const signals: string[] = [];
  if (observation.browserExercised) {
    signals.push('browser_context_exercised');
  }
  if (observation.httpExercised && observation.serverProcessSpawned) {
    signals.push('api_replay_against_spawned_server');
  }
  return signals;
};

const weakTier1Reasons = (observation: VerificationObservation): string[] => {
  const reasons: string[] = [];
  if (observation.httpExercised && !observation.serverProcessSpawned) {
    reasons.push('http_exercised_without_spawned_server');
  }
  if (observation.serverProcessSpawned && !observation.httpExercised) {
    reasons.push('server_spawned_without_http_exercise');
  }
  if (observation.dataPath === 'fixture-only') {
    reasons.push('fixture_only_data_path');
  }
  if (reasons.length === 0) {
    reasons.push('no_strong_tier_2_signal');
  }
  return reasons;
};

export const classifyTier = (observation: VerificationObservation): TierClassification => {
  if (observation.artifactPaths.length === 0) {
    return { tier: 0, reasons: ['no_counterfactual_artifact'] };
  }
  if (BUILD_TYPECHECK_RUNNERS.has(observation.runner)) {
    return { tier: 1, reasons: ['build_typecheck_repro_capped_at_tier_1'] };
  }
  const strong = strongTier2Signals(observation);
  if (strong.length > 0) {
    return { tier: 2, reasons: strong };
  }
  return { tier: 1, reasons: weakTier1Reasons(observation) };
};
