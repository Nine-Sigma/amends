import { describe, expect, it } from 'vitest';

import { emitFakeAdapter } from '../../tests/helpers/fake-adapter.js';
import { parseFixDiffPaths } from './diff-paths.js';

const gitDiff = [
  'diff --git a/src/total.js b/src/total.js',
  'index 1234567..89abcde 100644',
  '--- a/src/total.js',
  '+++ b/src/total.js',
  '@@ -1 +1 @@',
  '-export const total = (items) => items.reduce((sum, item) => sum + item.price, 0);',
  '+export const total = (items) => items.reduce((sum, item) => sum + item.price * item.quantity, 0);',
  'diff --git a/src/other.js b/src/other.js',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/src/other.js',
  '@@ -0,0 +1 @@',
  '+export const other = 1;',
  '',
].join('\n');

describe('parseFixDiffPaths', () => {
  it('extracts every touched path from real git diff output', () => {
    expect(parseFixDiffPaths(gitDiff)).toEqual(['src/total.js', 'src/other.js']);
  });

  it('collects a-side and b-side paths once each (renames touch both)', () => {
    const rename = 'diff --git a/src/before.js b/src/after.js\n';
    expect(parseFixDiffPaths(rename)).toEqual(['src/before.js', 'src/after.js']);
  });

  it('returns an empty list for an empty or non-diff string', () => {
    expect(parseFixDiffPaths('')).toEqual([]);
    expect(parseFixDiffPaths('not a diff at all')).toEqual([]);
  });

  it('agrees with the fake adapter about which paths its diffs touch', () => {
    const emit = emitFakeAdapter('touches-workflow');
    expect(parseFixDiffPaths(emit.fixDiff)).toEqual(emit.fixDiffPaths);
  });
});
