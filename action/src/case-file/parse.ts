import {
  isRecord,
  missingOr,
  requireNumber,
  requireRecord,
  requireString,
  requireStringArray,
} from '../utils/narrow.js';
import type { ParseError } from '../utils/narrow.js';
import type { CaseFile, ParseResult } from './types.js';

const validateGroup = (root: Record<string, unknown>, errors: ParseError[]): void => {
  const group = requireRecord(root, 'group', 'group', errors);
  if (group === undefined) return;
  requireRecord(group, 'fingerprints', 'group.fingerprints', errors);
  requireNumber(group, 'occurrence_count', 'group.occurrence_count', errors);
  requireString(group, 'first_seen', 'group.first_seen', errors);
  requireString(group, 'last_seen', 'group.last_seen', errors);
  requireStringArray(group, 'affected_revisions', 'group.affected_revisions', errors);
  requireStringArray(group, 'environments', 'group.environments', errors);
};

const validateResolution = (
  release: Record<string, unknown>,
  errors: ParseError[],
): void => {
  const resolution = requireRecord(release, 'resolution', 'release.resolution', errors);
  if (resolution === undefined) return;
  const status = resolution['status'];
  if (status !== 'resolved' && status !== 'unresolved') {
    errors.push({
      path: 'release.resolution.status',
      reason: missingOr(status, "'resolved' or 'unresolved'"),
    });
    return;
  }
  if (status === 'resolved') {
    requireString(resolution, 'method', 'release.resolution.method', errors);
    if (typeof release['revision'] !== 'string') {
      errors.push({
        path: 'release.revision',
        reason: "expected a revision string when resolution.status is 'resolved'",
      });
    }
  }
};

const validateRelease = (root: Record<string, unknown>, errors: ParseError[]): void => {
  const release = requireRecord(root, 'release', 'release', errors);
  if (release === undefined) return;
  requireString(release, 'declared', 'release.declared', errors);
  const revision = release['revision'];
  if (typeof revision !== 'string' && revision !== null) {
    errors.push({ path: 'release.revision', reason: missingOr(revision, 'a string or null') });
  }
  validateResolution(release, errors);
};

const validateWorkItem = (root: Record<string, unknown>, errors: ParseError[]): void => {
  const workItem = requireRecord(root, 'work_item', 'work_item', errors);
  if (workItem === undefined) return;
  requireString(workItem, 'kind', 'work_item.kind', errors);
  requireString(workItem, 'id', 'work_item.id', errors);
  requireString(workItem, 'url', 'work_item.url', errors);
};

export const parseCaseFile = (input: unknown): ParseResult => {
  if (!isRecord(input)) {
    return { ok: false, errors: [{ path: '$', reason: 'case file must be a JSON object' }] };
  }
  const errors: ParseError[] = [];
  requireString(input, 'schema_version', 'schema_version', errors);
  validateGroup(input, errors);
  requireRecord(input, 'representative_occurrence', 'representative_occurrence', errors);
  validateRelease(input, errors);
  validateWorkItem(input, errors);
  requireStringArray(input, 'intent_refs', 'intent_refs', errors);
  if ('validation' in input && !isRecord(input['validation'])) {
    errors.push({ path: 'validation', reason: 'expected an object' });
  }
  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, caseFile: input as CaseFile };
};
