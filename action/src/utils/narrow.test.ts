import { describe, expect, it } from 'vitest';

import type { ParseError } from './narrow.js';
import {
  isRecord,
  isStringArray,
  missingOr,
  requireBoolean,
  requireNumber,
  requireOneOf,
  requireRecord,
  requireString,
  requireStringArray,
} from './narrow.js';

describe('isRecord', () => {
  it.each([
    [{}, true],
    [{ a: 1 }, true],
    [[], false],
    [null, false],
    ['string', false],
    [42, false],
    [undefined, false],
  ])('classifies %j as %s', (value, expected) => {
    expect(isRecord(value)).toBe(expected);
  });
});

describe('isStringArray', () => {
  it.each([
    [[], true],
    [['a', 'b'], true],
    [['a', 1], false],
    ['not-array', false],
    [null, false],
  ])('classifies %j as %s', (value, expected) => {
    expect(isStringArray(value)).toBe(expected);
  });
});

describe('missingOr', () => {
  it('reports a missing field distinctly from a mistyped one', () => {
    expect(missingOr(undefined, 'a string')).toBe('required field is missing');
    expect(missingOr(42, 'a string')).toBe('expected a string');
  });
});

describe('require* accumulators', () => {
  it('push nothing for conformant values', () => {
    const errors: ParseError[] = [];
    const parent = { s: 'x', b: true, n: 1, a: ['y'], r: { k: 1 } };

    requireString(parent, 's', 's', errors);
    requireBoolean(parent, 'b', 'b', errors);
    requireNumber(parent, 'n', 'n', errors);
    requireStringArray(parent, 'a', 'a', errors);
    expect(requireRecord(parent, 'r', 'r', errors)).toEqual({ k: 1 });
    expect(errors).toEqual([]);
  });

  it('accumulate one structured error per violation at the given path', () => {
    const errors: ParseError[] = [];
    const parent = { s: 1, b: 'no', n: 'nan', a: [1], r: 'flat' };

    requireString(parent, 's', 'root.s', errors);
    requireBoolean(parent, 'b', 'root.b', errors);
    requireNumber(parent, 'n', 'root.n', errors);
    requireStringArray(parent, 'a', 'root.a', errors);
    expect(requireRecord(parent, 'r', 'root.r', errors)).toBeUndefined();

    expect(errors).toEqual([
      { path: 'root.s', reason: 'expected a string' },
      { path: 'root.b', reason: 'expected a boolean' },
      { path: 'root.n', reason: 'expected a number' },
      { path: 'root.a', reason: 'expected an array of strings' },
      { path: 'root.r', reason: 'expected an object' },
    ]);
  });
});

describe('requireOneOf', () => {
  it('returns the value when it is an allowed member', () => {
    const errors: ParseError[] = [];

    const value = requireOneOf({ kind: 'invariance' }, 'kind', 'kind', ['hard_blocked', 'invariance'], errors);

    expect(value).toBe('invariance');
    expect(errors).toEqual([]);
  });

  it('rejects unknown members and non-strings with the allowed set in the reason', () => {
    const errors: ParseError[] = [];

    expect(requireOneOf({ kind: 'other' }, 'kind', 'k', ['a', 'b'], errors)).toBeUndefined();
    expect(requireOneOf({ kind: 7 }, 'kind', 'k', ['a', 'b'], errors)).toBeUndefined();
    expect(requireOneOf({}, 'kind', 'k', ['a', 'b'], errors)).toBeUndefined();

    expect(errors).toEqual([
      { path: 'k', reason: "expected one of 'a' | 'b'" },
      { path: 'k', reason: "expected one of 'a' | 'b'" },
      { path: 'k', reason: 'required field is missing' },
    ]);
  });
});
