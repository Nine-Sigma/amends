import { describe, expect, it } from 'vitest';

import { resolveAutonomy } from './resolve-autonomy.js';

describe('resolveAutonomy', () => {
  describe('the full mode x tier matrix', () => {
    it.each([
      { mode: 'issue-only', tier: 0, autonomy: 'diagnostic_only', downgraded: true },
      { mode: 'issue-only', tier: 1, autonomy: 'issue_only', downgraded: false },
      { mode: 'issue-only', tier: 2, autonomy: 'issue_only', downgraded: false },
      { mode: 'pr', tier: 0, autonomy: 'diagnostic_only', downgraded: true },
      { mode: 'pr', tier: 1, autonomy: 'candidate_pr', downgraded: true },
      { mode: 'pr', tier: 2, autonomy: 'normal_pr', downgraded: false },
      { mode: 'auto-merge', tier: 0, autonomy: 'diagnostic_only', downgraded: true },
      { mode: 'auto-merge', tier: 1, autonomy: 'candidate_pr', downgraded: true },
      { mode: 'auto-merge', tier: 2, autonomy: 'automerge_eligible', downgraded: false },
    ] as const)(
      'mode $mode + Tier $tier resolves to $autonomy (downgraded: $downgraded)',
      ({ mode, tier, autonomy, downgraded }) => {
        const result = resolveAutonomy(mode, tier);

        expect(result.autonomy).toBe(autonomy);
        expect(result.downgraded).toBe(downgraded);
      },
    );
  });

  it('Tier 0 yields diagnostic_only regardless of mode', () => {
    for (const mode of ['issue-only', 'pr', 'auto-merge'] as const) {
      expect(resolveAutonomy(mode, 0).autonomy).toBe('diagnostic_only');
    }
  });

  it('every downgraded result carries a human-readable annotation', () => {
    const result = resolveAutonomy('auto-merge', 1);

    expect(result.downgraded).toBe(true);
    if (!result.downgraded) {
      return;
    }
    expect(result.annotation).toMatch(/auto-merge/);
    expect(result.annotation).toMatch(/[Tt]ier 1/);
    expect(result.annotation).toMatch(/candidate/);
  });

  it('non-downgraded results carry no annotation field', () => {
    const result = resolveAutonomy('pr', 2);

    expect(result.downgraded).toBe(false);
    expect('annotation' in result).toBe(false);
  });

  it('annotations respect language discipline — never "proven"', () => {
    for (const mode of ['issue-only', 'pr', 'auto-merge'] as const) {
      for (const tier of [0, 1, 2] as const) {
        const result = resolveAutonomy(mode, tier);
        if (result.downgraded) {
          expect(result.annotation.toLowerCase()).not.toContain('proven');
        }
      }
    }
  });
});
