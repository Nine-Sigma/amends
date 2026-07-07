import { parse as parseYaml } from 'yaml';

import { isRecord, isStringArray, missingOr } from '../utils/narrow.js';
import type { ParseError } from '../utils/narrow.js';
import type { AmendsConfig, LoadConfigResult, Mode } from './types.js';

/** §8.1: unconditionally re-added after any user override — the config file itself is attacker-reachable. */
const UNREMOVABLE_HARD_BLOCKED = ['.github/workflows/**', 'amends.yml'];

const DEFAULT_REVIEW_REQUIRED = [
  'package.json',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'src/auth/**',
  'src/session/**',
  'src/billing/**',
];

const DEFAULT_MAX_FILES_CHANGED = 10;

const MODES: readonly Mode[] = ['issue-only', 'pr', 'auto-merge'];

const isMode = (value: unknown): value is Mode => MODES.includes(value as Mode);

const defaultConfig = (): AmendsConfig => ({
  mode: 'pr',
  hard_blocked_paths: [...UNREMOVABLE_HARD_BLOCKED],
  review_required_paths: [...DEFAULT_REVIEW_REQUIRED],
  limits: { max_files_changed: DEFAULT_MAX_FILES_CHANGED },
});

const readMode = (root: Record<string, unknown>, errors: ParseError[]): Mode => {
  const value = root['mode'];
  if (value === undefined) return 'pr';
  if (!isMode(value)) {
    errors.push({ path: 'mode', reason: "expected 'issue-only', 'pr', or 'auto-merge'" });
    return 'pr';
  }
  return value;
};

const readPathList = (
  root: Record<string, unknown>,
  key: 'hard_blocked_paths' | 'review_required_paths',
  defaults: string[],
  errors: ParseError[],
): string[] => {
  const value = root[key];
  if (value === undefined) return defaults;
  if (!isStringArray(value)) {
    errors.push({ path: key, reason: missingOr(value, 'an array of strings') });
    return defaults;
  }
  return value;
};

const withUnremovable = (paths: string[]): string[] => [
  ...paths,
  ...UNREMOVABLE_HARD_BLOCKED.filter((required) => !paths.includes(required)),
];

const readMaxFilesChanged = (
  root: Record<string, unknown>,
  errors: ParseError[],
): number => {
  const limits = root['limits'];
  if (limits === undefined) return DEFAULT_MAX_FILES_CHANGED;
  if (!isRecord(limits)) {
    errors.push({ path: 'limits', reason: missingOr(limits, 'an object') });
    return DEFAULT_MAX_FILES_CHANGED;
  }
  const value = limits['max_files_changed'];
  if (value === undefined) return DEFAULT_MAX_FILES_CHANGED;
  if (typeof value !== 'number') {
    errors.push({ path: 'limits.max_files_changed', reason: missingOr(value, 'a number') });
    return DEFAULT_MAX_FILES_CHANGED;
  }
  return value;
};

const parseDocument = (fileContent: string): { root?: Record<string, unknown>; error?: ParseError } => {
  let parsed: unknown;
  try {
    parsed = parseYaml(fileContent);
  } catch (thrown) {
    const detail = thrown instanceof Error ? thrown.message : String(thrown);
    return { error: { path: '$', reason: `invalid YAML: ${detail}` } };
  }
  if (parsed === null || parsed === undefined) return {};
  if (!isRecord(parsed)) {
    return { error: { path: '$', reason: 'amends.yml must be a YAML mapping' } };
  }
  return { root: parsed };
};

export const loadConfig = (fileContent: string | undefined): LoadConfigResult => {
  if (fileContent === undefined) return { ok: true, config: defaultConfig() };
  const { root, error } = parseDocument(fileContent);
  if (error !== undefined) return { ok: false, errors: [error] };
  if (root === undefined) return { ok: true, config: defaultConfig() };

  const errors: ParseError[] = [];
  const config: AmendsConfig = {
    mode: readMode(root, errors),
    hard_blocked_paths: withUnremovable(
      readPathList(root, 'hard_blocked_paths', [...UNREMOVABLE_HARD_BLOCKED], errors),
    ),
    review_required_paths: readPathList(
      root,
      'review_required_paths',
      [...DEFAULT_REVIEW_REQUIRED],
      errors,
    ),
    limits: { max_files_changed: readMaxFilesChanged(root, errors) },
  };
  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, config };
};
