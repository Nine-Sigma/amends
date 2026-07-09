import { join } from 'node:path';

import { commandFailureSignature } from './exec.js';
import type { CommandResult, CommandRunner } from './exec.js';
import type { FileWriter } from './fs.js';

/** Inside .git on purpose: outside the worktree, so checkout/clean never see it. */
export const PATCH_SCRATCH_PATH = '.git/amends-fix.patch';

export interface ApplyFixDiffRequest {
  repoPath: string;
  fixDiff: string;
  env: Readonly<Record<string, string>>;
  timeoutMs: number;
}

export type ApplyFixDiffResult =
  | { applied: true }
  | { applied: false; failureSignature: string };

/** A non-applying diff is an adapter fault, returned structured — never thrown. */
export const applyFixDiff = async (
  request: ApplyFixDiffRequest,
  runner: CommandRunner,
  files: FileWriter,
): Promise<ApplyFixDiffResult> => {
  if (request.fixDiff.trim() === '') return { applied: true };
  await files.write(join(request.repoPath, PATCH_SCRATCH_PATH), request.fixDiff);
  const result = await runner.run({
    command: 'git',
    args: ['apply', PATCH_SCRATCH_PATH],
    cwd: request.repoPath,
    env: { ...request.env },
    timeoutMs: request.timeoutMs,
  });
  if (result.kind === 'completed' && result.exitCode === 0) return { applied: true };
  return { applied: false, failureSignature: `git apply failed: ${commandFailureSignature(result)}` };
};

export type EnumerateFixDiffPathsResult =
  | { ok: true; paths: string[] }
  | { ok: false; reason: string };

const NUMSTAT_ENTRY = /^(?:\d+|-)\t(?:\d+|-)\t([\s\S]*)$/;

/** `--numstat -z` entries are `added\tremoved\tpath\0`; some git versions emit renames as `added\tremoved\t\0old\0new\0`. */
const parseNumstatOutput = (raw: string): string[] | undefined => {
  const tokens = raw.split('\0');
  if (tokens.at(-1) === '') tokens.pop();
  const paths: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const match = NUMSTAT_ENTRY.exec(tokens[index] ?? '');
    const path = match?.[1];
    if (path === undefined) return undefined;
    if (path === '') {
      const oldPath = tokens[index + 1];
      const newPath = tokens[index + 2];
      if (oldPath === undefined || oldPath === '' || newPath === undefined || newPath === '') {
        return undefined;
      }
      paths.push(oldPath, newPath);
      index += 2;
    } else {
      paths.push(path);
    }
  }
  return paths;
};

const SUMMARY_RENAME = /^ (?:rename|copy) (.+) \(\d+%\)$/;
const SUMMARY_MODE_CHANGE = /^ mode change \d+ => \d+ (.+)$/;

const expandSummaryArrow = (compact: string): { from: string; to: string } | undefined => {
  const braced = /^(.*)\{(.*) => (.*)\}(.*)$/.exec(compact);
  if (braced) {
    const [, prefix = '', from = '', to = '', suffix = ''] = braced;
    return {
      from: (prefix + from + suffix).replaceAll(/\/{2,}/g, '/'),
      to: (prefix + to + suffix).replaceAll(/\/{2,}/g, '/'),
    };
  }
  const plain = /^(.+) => (.+)$/.exec(compact);
  if (plain?.[1] === undefined || plain[2] === undefined) return undefined;
  return { from: plain[1], to: plain[2] };
};

/**
 * numstat lists only the new side of a rename/copy and may quote paths in
 * `--summary`; the expanded new-path must match a numstat path exactly or the
 * diff is refused — never silently under-enumerated.
 */
const reconcileSummary = (summaryRaw: string, paths: Set<string>): string | undefined => {
  for (const line of summaryRaw.split('\n')) {
    const renamed = SUMMARY_RENAME.exec(line)?.[1];
    if (renamed !== undefined) {
      const expanded = expandSummaryArrow(renamed);
      if (expanded === undefined || !paths.has(expanded.to)) {
        return `unresolvable rename/copy entry: ${renamed}`;
      }
      paths.add(expanded.from);
      continue;
    }
    const modeChanged = SUMMARY_MODE_CHANGE.exec(line)?.[1];
    if (modeChanged !== undefined && !paths.has(modeChanged)) {
      return `mode change on unenumerated path: ${modeChanged}`;
    }
  }
  return undefined;
};

/**
 * The paths `git apply` will actually write, derived from git itself — never
 * from re-parsing diff headers (a bare header-less diff, quoted paths, and
 * renames all defeat text parsing). Guardrails judge this list. Any failure
 * to enumerate is a refusal, not "clear" (fail closed, §8.1).
 */
export const enumerateFixDiffPaths = async (
  request: ApplyFixDiffRequest,
  runner: CommandRunner,
  files: FileWriter,
): Promise<EnumerateFixDiffPathsResult> => {
  if (request.fixDiff.trim() === '') return { ok: true, paths: [] };
  await files.write(join(request.repoPath, PATCH_SCRATCH_PATH), request.fixDiff);
  const gitApply = (flags: string[]): Promise<CommandResult> =>
    runner.run({
      command: 'git',
      args: ['apply', ...flags, PATCH_SCRATCH_PATH],
      cwd: request.repoPath,
      env: { ...request.env },
      timeoutMs: request.timeoutMs,
    });

  const numstat = await gitApply(['--numstat', '-z']);
  if (numstat.kind !== 'completed' || numstat.exitCode !== 0) {
    return { ok: false, reason: `git apply --numstat failed: ${commandFailureSignature(numstat)}` };
  }
  const parsed = parseNumstatOutput(numstat.stdout);
  if (parsed === undefined) {
    return { ok: false, reason: 'unparseable git apply --numstat output' };
  }
  const paths = new Set(parsed);

  const summary = await gitApply(['--summary']);
  if (summary.kind !== 'completed' || summary.exitCode !== 0) {
    return { ok: false, reason: `git apply --summary failed: ${commandFailureSignature(summary)}` };
  }
  const mismatch = reconcileSummary(summary.stdout, paths);
  if (mismatch !== undefined) return { ok: false, reason: mismatch };
  return { ok: true, paths: [...paths] };
};
