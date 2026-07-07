/**
 * Hand-rolled narrowing helpers for trust boundaries (§8.1): everything
 * crossing the ingest boundary is unknown until validated. Errors accumulate
 * as { path, reason } records; nothing here throws for control flow.
 */

export interface ParseError {
  /** Dot-separated JSON path from the document root; '$' is the root itself. */
  path: string;
  reason: string;
}

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === 'string');

export const missingOr = (value: unknown, expected: string): string =>
  value === undefined ? 'required field is missing' : `expected ${expected}`;

export const requireString = (
  parent: Record<string, unknown>,
  key: string,
  path: string,
  errors: ParseError[],
): void => {
  if (typeof parent[key] !== 'string') {
    errors.push({ path, reason: missingOr(parent[key], 'a string') });
  }
};

export const requireNumber = (
  parent: Record<string, unknown>,
  key: string,
  path: string,
  errors: ParseError[],
): void => {
  if (typeof parent[key] !== 'number') {
    errors.push({ path, reason: missingOr(parent[key], 'a number') });
  }
};

export const requireStringArray = (
  parent: Record<string, unknown>,
  key: string,
  path: string,
  errors: ParseError[],
): void => {
  if (!isStringArray(parent[key])) {
    errors.push({ path, reason: missingOr(parent[key], 'an array of strings') });
  }
};

export const requireRecord = (
  parent: Record<string, unknown>,
  key: string,
  path: string,
  errors: ParseError[],
): Record<string, unknown> | undefined => {
  const value = parent[key];
  if (!isRecord(value)) {
    errors.push({ path, reason: missingOr(value, 'an object') });
    return undefined;
  }
  return value;
};
