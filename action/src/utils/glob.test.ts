import { describe, expect, it } from 'vitest';

import { matchesGlob, pathsMatchingAnyGlob } from './glob.js';

describe('matchesGlob', () => {
  it('spans path segments with **', () => {
    expect(matchesGlob('.github/workflows/nested/deploy.yml', '.github/workflows/**')).toBe(true);
    expect(matchesGlob('.github/actions/setup.yml', '.github/workflows/**')).toBe(false);
  });

  it('keeps * within one segment', () => {
    expect(matchesGlob('vitest.config.ts', 'vitest.config.*')).toBe(true);
    expect(matchesGlob('src/auth/deep/nested.ts', 'src/auth/*')).toBe(false);
  });

  it('matches a slash-less pattern against the basename at any depth', () => {
    expect(matchesGlob('packages/api/tsconfig.json', 'tsconfig*.json')).toBe(true);
    expect(matchesGlob('packages/api/package.json', 'package.json')).toBe(true);
  });

  it('anchors patterns containing a slash to the path root', () => {
    expect(matchesGlob('vendor/.github/workflows/ci.yml', '.github/workflows/**')).toBe(false);
  });

  it('does not let glob syntax escape into regex syntax', () => {
    expect(matchesGlob('amendsXyml', 'amends.yml')).toBe(false);
  });
});

describe('pathsMatchingAnyGlob', () => {
  it('returns only the paths matching at least one pattern, in input order', () => {
    const matched = pathsMatchingAnyGlob(
      ['src/a.ts', 'amends.yml', '.github/workflows/ci.yml'],
      ['amends.yml', '.github/workflows/**'],
    );
    expect(matched).toEqual(['amends.yml', '.github/workflows/ci.yml']);
  });
});
