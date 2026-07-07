import { join } from 'node:path';

import { commandFailureSignature } from './exec.js';
import type { CommandRunner } from './exec.js';
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
