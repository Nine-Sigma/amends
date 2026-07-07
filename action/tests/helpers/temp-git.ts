import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Throwaway git repo with a planted bug commit and a runnable test setup
 * (used by US-008 counterfactual tests and US-010's integration test).
 * The planted app is dependency-free on purpose: artifacts run via plain
 * `node`, so verification needs no install step inside the fixture repo.
 */
export interface TempGitRepo {
  repoPath: string;
  /** The original revision: the commit that plants the bug. */
  bugCommit: string;
  /** Unified diff (captured via `git diff`) that fixes the planted bug. */
  fixDiff: string;
  /** Repo-relative path where counterfactual artifacts conventionally land. */
  artifactPath: string;
  testCommand: { command: string; args: string[] };
  cleanup(): Promise<void>;
}

const BUGGY_TOTAL =
  'export const total = (items) => items.reduce((sum, item) => sum + item.price, 0);\n';

const FIXED_TOTAL =
  'export const total = (items) => items.reduce((sum, item) => sum + item.price * item.quantity, 0);\n';

/** Fails on the planted bug (total ignores quantity) and passes once fixed. */
export const COUNTERFACTUAL_NODE_ARTIFACT = [
  "import assert from 'node:assert/strict';",
  "import { total } from './src/total.js';",
  '',
  'assert.equal(total([{ price: 5, quantity: 3 }]), 15);',
  '',
].join('\n');

export const createTempGitRepo = async (): Promise<TempGitRepo> => {
  const repoPath = await mkdtemp(join(tmpdir(), 'amends-temp-git-'));
  const git = async (...args: string[]): Promise<string> => {
    const { stdout } = await execFileAsync('git', args, { cwd: repoPath });
    return stdout;
  };

  await git('init', '--initial-branch=main');
  await git('config', 'user.name', 'Amends Test');
  await git('config', 'user.email', 'test@amends.invalid');
  await writeFile(
    join(repoPath, 'package.json'),
    JSON.stringify({ name: 'planted-demo', version: '0.0.0', type: 'module' }, null, 2),
  );
  await mkdir(join(repoPath, 'src'), { recursive: true });
  await writeFile(join(repoPath, 'src/total.js'), BUGGY_TOTAL);
  await git('add', '.');
  await git('commit', '-m', 'plant bug: total ignores quantity');
  const bugCommit = (await git('rev-parse', 'HEAD')).trim();

  await writeFile(join(repoPath, 'src/total.js'), FIXED_TOTAL);
  const fixDiff = await git('diff');
  await git('checkout', '--', '.');

  return {
    repoPath,
    bugCommit,
    fixDiff,
    artifactPath: 'artifact.test.mjs',
    testCommand: { command: 'node', args: ['artifact.test.mjs'] },
    cleanup: () => rm(repoPath, { recursive: true, force: true }),
  };
};
