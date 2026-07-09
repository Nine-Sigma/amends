import { commandFailureSignature } from './exec.js';
import type { CommandRunner } from './exec.js';

export interface GitContext {
  runner: CommandRunner;
  repoPath: string;
  env: Readonly<Record<string, string>>;
  timeoutMs: number;
}

/** A failing git command here is an environment fault, never adapter output — it throws, callers do not branch on it. */
export const runGitOrThrow = async (
  context: GitContext,
  args: readonly string[],
): Promise<string> => {
  const result = await context.runner.run({
    command: 'git',
    args: [...args],
    cwd: context.repoPath,
    env: { ...context.env },
    timeoutMs: context.timeoutMs,
  });
  if (result.kind !== 'completed' || result.exitCode !== 0) {
    throw new Error(
      `git ${args.join(' ')} failed in ${context.repoPath}: ${commandFailureSignature(result)}`,
    );
  }
  return result.stdout;
};

/**
 * Every stage runs against the incident's release.revision, not the trigger
 * HEAD (detached HEAD is fine). clean -fd removes untracked leftovers so
 * repeated runs are identical (§7.1); requires a full-history checkout
 * (fetch-depth: 0) when the revision is not the trigger HEAD.
 */
export const checkoutRevision = async (context: GitContext, revision: string): Promise<void> => {
  await runGitOrThrow(context, ['checkout', '--force', revision]);
  await runGitOrThrow(context, ['clean', '-fd']);
};
