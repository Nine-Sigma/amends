import type { Mode } from '../config/types.js';
import type { Tier } from './classify.js';

export type EffectiveAutonomy =
  | 'diagnostic_only'
  | 'issue_only'
  | 'candidate_pr'
  | 'normal_pr'
  | 'automerge_eligible';

export type AutonomyResolution =
  | { autonomy: EffectiveAutonomy; downgraded: false }
  | { autonomy: EffectiveAutonomy; downgraded: true; annotation: string };

const MODE_CEILINGS: Record<Mode, EffectiveAutonomy> = {
  'issue-only': 'issue_only',
  pr: 'normal_pr',
  'auto-merge': 'automerge_eligible',
};

const downgrade = (autonomy: EffectiveAutonomy, mode: Mode, tier: Tier): AutonomyResolution => ({
  autonomy,
  downgraded: true,
  annotation:
    `Requested mode '${mode}' allows up to '${MODE_CEILINGS[mode]}', but the verification ` +
    `evidence classified mechanically at Tier ${String(tier)}; ` +
    `effective autonomy is '${autonomy}'.`,
});

/**
 * Effective autonomy = min(requested mode, earned evidence tier) — product
 * PRD §7.2: silently degrading, loudly annotated. Agent self-report can
 * never raise autonomy because tier comes only from classifyTier over the
 * mechanical VerificationObservation.
 */
export const resolveAutonomy = (mode: Mode, tier: Tier): AutonomyResolution => {
  if (tier === 0) {
    return downgrade('diagnostic_only', mode, tier);
  }
  if (mode === 'issue-only') {
    return { autonomy: 'issue_only', downgraded: false };
  }
  if (tier === 1) {
    return downgrade('candidate_pr', mode, tier);
  }
  return mode === 'pr'
    ? { autonomy: 'normal_pr', downgraded: false }
    : { autonomy: 'automerge_eligible', downgraded: false };
};
