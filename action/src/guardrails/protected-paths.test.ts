import { describe, expect, it } from 'vitest';

import { loadConfig } from '../config/load-config.js';
import type { AmendsConfig } from '../config/types.js';
import { classifyDiffPaths } from './protected-paths.js';

function defaultConfig(): AmendsConfig {
  const result = loadConfig(undefined);
  if (!result.ok) throw new Error('default config must load');
  return result.config;
}

describe('classifyDiffPaths', () => {
  it('classifies a diff touching .github/workflows/release.yml as hard_blocked', () => {
    const verdict = classifyDiffPaths(
      ['src/checkout/total.ts', '.github/workflows/release.yml'],
      defaultConfig(),
    );

    expect(verdict).toEqual({
      kind: 'hard_blocked',
      paths: ['.github/workflows/release.yml'],
    });
  });

  it.each([
    '.github/workflows/ci.yml',
    '.github/workflows/nested/deploy.yml',
    'amends.yml',
  ])('classifies %s as hard_blocked (default hard-blocked class)', (path) => {
    const verdict = classifyDiffPaths([path], defaultConfig());
    expect(verdict).toEqual({ kind: 'hard_blocked', paths: [path] });
  });

  it.each([
    'package.json',
    'package-lock.json',
    'pnpm-lock.yaml',
    'yarn.lock',
    'src/auth/login.ts',
    'src/session/store.ts',
    'src/billing/invoice.ts',
  ])('classifies %s as review_required (default review-required class)', (path) => {
    const verdict = classifyDiffPaths([path], defaultConfig());
    expect(verdict).toEqual({ kind: 'review_required', paths: [path] });
  });

  it('classifies a nested package.json as review_required', () => {
    const verdict = classifyDiffPaths(['packages/api/package.json'], defaultConfig());
    expect(verdict).toEqual({ kind: 'review_required', paths: ['packages/api/package.json'] });
  });

  it('hard_blocked wins when a diff touches both classes', () => {
    const verdict = classifyDiffPaths(
      ['package.json', 'amends.yml', 'src/auth/login.ts'],
      defaultConfig(),
    );
    expect(verdict).toEqual({ kind: 'hard_blocked', paths: ['amends.yml'] });
  });

  it('classifies a benign source-only diff as clear', () => {
    const verdict = classifyDiffPaths(
      ['src/checkout/total.ts', 'src/checkout/total.test.ts'],
      defaultConfig(),
    );
    expect(verdict).toEqual({ kind: 'clear' });
  });

  it('classifies an empty diff as clear', () => {
    expect(classifyDiffPaths([], defaultConfig())).toEqual({ kind: 'clear' });
  });

  it('honors user-replaced review_required_paths from config', () => {
    const result = loadConfig('review_required_paths:\n  - "src/payments/**"\n');
    if (!result.ok) throw new Error('config must load');

    expect(classifyDiffPaths(['src/payments/charge.ts'], result.config)).toEqual({
      kind: 'review_required',
      paths: ['src/payments/charge.ts'],
    });
    expect(classifyDiffPaths(['src/auth/login.ts'], result.config)).toEqual({ kind: 'clear' });
  });
});
