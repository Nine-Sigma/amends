import { execFile } from 'node:child_process';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import { createTempGitRepo } from '../../tests/helpers/temp-git.js';
import type { TempGitRepo } from '../../tests/helpers/temp-git.js';
import { createCommandRunner } from './exec.js';
import { checkoutRevision, runGitOrThrow } from './git.js';
import type { GitContext } from './git.js';

const execFileAsync = promisify(execFile);

const INTEGRATION_TIMEOUT = 30_000;

describe('git helpers', () => {
  let repo: TempGitRepo | undefined;

  afterEach(async () => {
    await repo?.cleanup();
    repo = undefined;
  });

  const contextFor = (activeRepo: TempGitRepo): GitContext => ({
    runner: createCommandRunner(),
    repoPath: activeRepo.repoPath,
    env: { PATH: process.env['PATH'] ?? '' },
    timeoutMs: INTEGRATION_TIMEOUT,
  });

  it(
    'runGitOrThrow returns stdout on success and throws with the failure signature otherwise',
    async () => {
      repo = await createTempGitRepo();
      const context = contextFor(repo);

      const head = await runGitOrThrow(context, ['rev-parse', 'HEAD']);
      expect(head.trim()).toBe(repo.bugCommit);

      await expect(runGitOrThrow(context, ['checkout', 'no-such-revision'])).rejects.toThrow(
        /git checkout no-such-revision failed/,
      );
    },
    INTEGRATION_TIMEOUT,
  );

  it(
    'checkoutRevision forces the tree back to the revision and removes untracked leftovers',
    async () => {
      repo = await createTempGitRepo();
      const context = contextFor(repo);
      const git = (...args: string[]) => execFileAsync('git', args, { cwd: repo?.repoPath ?? '' });

      await writeFile(join(repo.repoPath, 'src/total.js'), 'drifted content\n');
      await git('add', '-A');
      await git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-m', 'drift');
      await writeFile(join(repo.repoPath, 'leftover.tmp'), 'untracked\n');

      await checkoutRevision(context, repo.bugCommit);

      const restored = await readFile(join(repo.repoPath, 'src/total.js'), 'utf8');
      expect(restored).toContain('item.price, 0');
      await expect(stat(join(repo.repoPath, 'leftover.tmp'))).rejects.toThrow();
    },
    INTEGRATION_TIMEOUT,
  );
});
