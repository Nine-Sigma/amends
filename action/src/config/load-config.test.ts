import { describe, expect, it } from 'vitest';

import { loadConfig } from './load-config.js';

const expectOk = (content: string | undefined) => {
  const result = loadConfig(content);
  if (!result.ok) {
    throw new Error(`expected ok, got errors: ${JSON.stringify(result.errors)}`);
  }
  return result.config;
};

const expectErrorAt = (content: string | undefined, path: string): void => {
  const result = loadConfig(content);
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.errors.map((error) => error.path)).toContain(path);
  for (const error of result.errors) {
    expect(error.reason).not.toBe('');
  }
};

describe('loadConfig defaults', () => {
  it('when amends.yml is absent, defaults match PRD §8.1/§11', () => {
    const config = expectOk(undefined);
    expect(config.mode).toBe('pr');
    expect(config.hard_blocked_paths).toEqual(['.github/workflows/**', 'amends.yml']);
    expect(config.review_required_paths).toEqual([
      'package.json',
      'package-lock.json',
      'pnpm-lock.yaml',
      'yarn.lock',
      'src/auth/**',
      'src/session/**',
      'src/billing/**',
    ]);
    expect(config.limits.max_files_changed).toBe(10);
  });

  it('an empty file yields the same defaults as an absent file', () => {
    expect(expectOk('')).toEqual(expectOk(undefined));
  });

  it('a file setting unrelated §11 keys leaves the Phase-1 subset at defaults', () => {
    const config = expectOk('agent: claude-code\nmodel:\n  provider: bedrock\n');
    expect(config).toEqual(expectOk(undefined));
  });
});

describe('loadConfig mode', () => {
  it.each(['issue-only', 'pr', 'auto-merge'] as const)('accepts mode %s', (mode) => {
    expect(expectOk(`mode: ${mode}\n`).mode).toBe(mode);
  });

  it('rejects an invalid mode with a structured error, not a fallback', () => {
    expectErrorAt('mode: auto-deploy\n', 'mode');
  });

  it('rejects a non-string mode', () => {
    expectErrorAt('mode: 3\n', 'mode');
  });
});

describe('loadConfig hard_blocked_paths override semantics', () => {
  it('re-adds .github/workflows/** and amends.yml after a hostile override', () => {
    const config = expectOk('hard_blocked_paths:\n  - src/harmless/**\n');
    expect(config.hard_blocked_paths).toContain('src/harmless/**');
    expect(config.hard_blocked_paths).toContain('.github/workflows/**');
    expect(config.hard_blocked_paths).toContain('amends.yml');
  });

  it('does not duplicate the unremovable pair when the user lists them', () => {
    const config = expectOk(
      'hard_blocked_paths:\n  - amends.yml\n  - .github/workflows/**\n  - infra/**\n',
    );
    const occurrences = config.hard_blocked_paths.filter((path) => path === 'amends.yml');
    expect(occurrences).toHaveLength(1);
    expect(config.hard_blocked_paths).toContain('infra/**');
  });

  it('an empty user list still yields the unremovable pair', () => {
    const config = expectOk('hard_blocked_paths: []\n');
    expect(config.hard_blocked_paths).toEqual(['.github/workflows/**', 'amends.yml']);
  });

  it('rejects a non-string-array value with a structured error', () => {
    expectErrorAt('hard_blocked_paths: nope\n', 'hard_blocked_paths');
  });
});

describe('loadConfig review_required_paths override semantics', () => {
  it('a user list replaces the defaults outright', () => {
    const config = expectOk('review_required_paths:\n  - src/payments/**\n');
    expect(config.review_required_paths).toEqual(['src/payments/**']);
  });

  it('rejects a non-string-array value with a structured error', () => {
    expectErrorAt('review_required_paths: 7\n', 'review_required_paths');
  });
});

describe('loadConfig limits', () => {
  it('honors a user max_files_changed', () => {
    expect(expectOk('limits:\n  max_files_changed: 3\n').limits.max_files_changed).toBe(3);
  });

  it('defaults max_files_changed when limits is present without it', () => {
    expect(expectOk('limits:\n  max_prs_per_day: 5\n').limits.max_files_changed).toBe(10);
  });

  it('rejects a non-number max_files_changed', () => {
    expectErrorAt('limits:\n  max_files_changed: ten\n', 'limits.max_files_changed');
  });

  it('rejects a non-object limits value', () => {
    expectErrorAt('limits: 4\n', 'limits');
  });
});

describe('loadConfig malformed input', () => {
  it('rejects invalid YAML with a structured error at the root', () => {
    expectErrorAt('mode: [unclosed\n', '$');
  });

  it('rejects a non-object document with a structured error at the root', () => {
    expectErrorAt('- just\n- a\n- list\n', '$');
  });

  it('accumulates errors across fields instead of stopping at the first', () => {
    const result = loadConfig('mode: bogus\nhard_blocked_paths: nope\n');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.map((error) => error.path)).toEqual(
      expect.arrayContaining(['mode', 'hard_blocked_paths']),
    );
  });
});
