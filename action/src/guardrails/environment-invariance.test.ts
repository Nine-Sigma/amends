import { describe, expect, it } from 'vitest';

import { checkInvariance, VERIFICATION_CONFIG_SET } from './environment-invariance.js';

const NO_ARTIFACTS: string[] = [];

describe('checkInvariance', () => {
  it('rejects a fix diff touching vitest.config.ts but exempts a new artifact test file', () => {
    const verdict = checkInvariance(
      {
        fixDiffPaths: ['src/checkout/total.ts', 'vitest.config.ts'],
        artifactPaths: ['src/checkout/total.counterfactual.test.ts'],
      },
      VERIFICATION_CONFIG_SET,
    );

    expect(verdict).toEqual({ kind: 'violation', paths: ['vitest.config.ts'] });
  });

  it('names the file when a fix diff touches a tsconfig', () => {
    const verdict = checkInvariance(
      { fixDiffPaths: ['tsconfig.base.json', 'src/fix.ts'], artifactPaths: NO_ARTIFACTS },
      VERIFICATION_CONFIG_SET,
    );
    expect(verdict).toEqual({ kind: 'violation', paths: ['tsconfig.base.json'] });
  });

  it.each([
    '.github/workflows/ci.yml',
    'amends.yml',
    'tsconfig.json',
    'tsconfig.build.json',
    'vitest.config.ts',
    'jest.config.js',
    'playwright.config.mjs',
    '.nvmrc',
    '.node-version',
    '.tool-versions',
  ])('rejects a fix diff touching %s (verification-config set member)', (path) => {
    const verdict = checkInvariance(
      { fixDiffPaths: [path], artifactPaths: NO_ARTIFACTS },
      VERIFICATION_CONFIG_SET,
    );
    expect(verdict).toEqual({ kind: 'violation', paths: [path] });
  });

  it('does NOT flag lockfiles or package.json — those are review_required, not invariance', () => {
    const verdict = checkInvariance(
      { fixDiffPaths: ['pnpm-lock.yaml', 'package.json', 'src/fix.ts'], artifactPaths: NO_ARTIFACTS },
      VERIFICATION_CONFIG_SET,
    );
    expect(verdict).toEqual({ kind: 'ok' });
  });

  it('passes an artifact-only change (new test file, empty fix diff)', () => {
    const verdict = checkInvariance(
      { fixDiffPaths: [], artifactPaths: ['src/checkout/total.counterfactual.test.ts'] },
      VERIFICATION_CONFIG_SET,
    );
    expect(verdict).toEqual({ kind: 'ok' });
  });

  it('passes an empty diff', () => {
    const verdict = checkInvariance(
      { fixDiffPaths: [], artifactPaths: NO_ARTIFACTS },
      VERIFICATION_CONFIG_SET,
    );
    expect(verdict).toEqual({ kind: 'ok' });
  });

  it('passes a benign source-only fix diff', () => {
    const verdict = checkInvariance(
      { fixDiffPaths: ['src/checkout/total.ts'], artifactPaths: NO_ARTIFACTS },
      VERIFICATION_CONFIG_SET,
    );
    expect(verdict).toEqual({ kind: 'ok' });
  });
});
