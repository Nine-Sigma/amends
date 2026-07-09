import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';
import { createCommandRunner } from '../utils/exec.js';
import type { CommandRequest, CommandResult, CommandRunner } from '../utils/exec.js';
import type { OctokitLike } from './client.js';
import { createOctokitGitHubClient } from './client.js';

const execFileAsync = promisify(execFile);

interface RecordingRunner extends CommandRunner {
  readonly requests: CommandRequest[];
}

const recordingRunner = (result?: CommandResult): RecordingRunner => {
  const requests: CommandRequest[] = [];
  return {
    requests,
    run: (request) => {
      requests.push(request);
      return Promise.resolve(
        result ?? { kind: 'completed', exitCode: 0, stdout: '', stderr: '' },
      );
    },
  };
};

interface RecordingOctokit extends OctokitLike {
  readonly calls: { method: string; params: Record<string, unknown> }[];
}

const recordingOctokit = (): RecordingOctokit => {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  return {
    calls,
    rest: {
      pulls: {
        create: (params) => {
          calls.push({ method: 'pulls.create', params });
          return Promise.resolve({ data: { number: 42, html_url: 'https://github.com/o/r/pull/42' } });
        },
      },
      issues: {
        addLabels: (params) => {
          calls.push({ method: 'issues.addLabels', params });
          return Promise.resolve({});
        },
        createComment: (params) => {
          calls.push({ method: 'issues.createComment', params });
          return Promise.resolve({});
        },
      },
    },
  };
};

const makeClient = (runner: CommandRunner, octokit: OctokitLike) =>
  createOctokitGitHubClient({
    octokit,
    runner,
    repo: { owner: 'example-org', repo: 'shop-api' },
    checkoutPath: '/tmp/checkout',
    env: { PATH: '/usr/bin' },
    timeoutMs: 30_000,
  });

describe('createOctokitGitHubClient', () => {
  it('createBranchAndPush stages exactly the given paths, then commits and pushes', async () => {
    const runner = recordingRunner();
    const client = makeClient(runner, recordingOctokit());

    await client.createBranchAndPush({
      branch: 'amends/fix-1301',
      commitMessage: 'fix: pay route',
      paths: ['src/pay.js', 'artifact.test.mjs'],
    });

    expect(runner.requests.map((request) => request.args[0])).toEqual([
      'checkout',
      'add',
      'commit',
      'push',
    ]);
    for (const request of runner.requests) {
      expect(request.command).toBe('git');
      expect(request.cwd).toBe('/tmp/checkout');
      expect(request.env).toEqual({ PATH: '/usr/bin' });
    }
    expect(runner.requests[0]?.args).toEqual(['checkout', '-b', 'amends/fix-1301']);
    expect(runner.requests[1]?.args).toEqual(['add', '--', 'src/pay.js', 'artifact.test.mjs']);
    expect(runner.requests[3]?.args).toEqual(['push', 'origin', 'amends/fix-1301']);
  });

  it('createBranchAndPush rejects on a nonzero git exit (environment fault)', async () => {
    const runner = recordingRunner({ kind: 'completed', exitCode: 128, stdout: '', stderr: 'fatal: not a git repository' });
    const client = makeClient(runner, recordingOctokit());

    await expect(
      client.createBranchAndPush({ branch: 'b', commitMessage: 'm', paths: ['f.js'] }),
    ).rejects.toThrow(/exited 128/);
  });

  it('createBranchAndPush rejects on timeout', async () => {
    const runner = recordingRunner({ kind: 'timed_out', timeoutMs: 30_000 });
    const client = makeClient(runner, recordingOctokit());

    await expect(
      client.createBranchAndPush({ branch: 'b', commitMessage: 'm', paths: ['f.js'] }),
    ).rejects.toThrow(/timed out/);
  });

  it(
    'against a real repo, an unrelated untracked file (handoff bundle) is never staged onto the branch',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'amends-client-'));
      const repoPath = join(root, 'checkout');
      const remotePath = join(root, 'origin.git');
      const git = async (cwd: string, ...args: string[]): Promise<string> => {
        const { stdout } = await execFileAsync('git', args, { cwd });
        return stdout;
      };
      try {
        await mkdir(repoPath, { recursive: true });
        await execFileAsync('git', ['init', '--bare', remotePath]);
        await git(root, 'init', '--initial-branch=main', 'checkout');
        await git(repoPath, 'config', 'user.name', 'Amends Test');
        await git(repoPath, 'config', 'user.email', 'test@amends.invalid');
        await git(repoPath, 'remote', 'add', 'origin', remotePath);
        await mkdir(join(repoPath, 'src'), { recursive: true });
        await writeFile(join(repoPath, 'src/pay.js'), 'buggy\n');
        await git(repoPath, 'add', '-A');
        await git(repoPath, 'commit', '-m', 'init');

        await writeFile(join(repoPath, 'src/pay.js'), 'fixed\n');
        await mkdir(join(repoPath, 'amends-out'), { recursive: true });
        await writeFile(join(repoPath, 'amends-out/fix-bundle.json'), '{"secret":"handoff"}');

        const client = createOctokitGitHubClient({
          octokit: recordingOctokit(),
          runner: createCommandRunner(),
          repo: { owner: 'o', repo: 'r' },
          checkoutPath: repoPath,
          env: {
            PATH: process.env['PATH'] ?? '',
            GIT_AUTHOR_NAME: 'Amends Test',
            GIT_AUTHOR_EMAIL: 'test@amends.invalid',
            GIT_COMMITTER_NAME: 'Amends Test',
            GIT_COMMITTER_EMAIL: 'test@amends.invalid',
          },
          timeoutMs: 30_000,
        });
        await client.createBranchAndPush({
          branch: 'amends/fix-pay',
          commitMessage: 'fix: pay route',
          paths: ['src/pay.js'],
        });

        const committed = await git(repoPath, 'show', '--name-only', '--format=', 'HEAD');
        expect(committed.trim().split('\n')).toEqual(['src/pay.js']);
        const pushed = await git(root, '--git-dir', remotePath, 'ls-tree', '-r', '--name-only', 'amends/fix-pay');
        expect(pushed.trim().split('\n')).toEqual(['src/pay.js']);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
    30_000,
  );

  it('openPullRequest maps to pulls.create and returns number + url', async () => {
    const octokit = recordingOctokit();
    const client = makeClient(recordingRunner(), octokit);

    const pr = await client.openPullRequest({ title: 't', body: 'b', head: 'amends/fix', base: 'main' });

    expect(pr).toEqual({ number: 42, url: 'https://github.com/o/r/pull/42' });
    expect(octokit.calls).toEqual([
      {
        method: 'pulls.create',
        params: { owner: 'example-org', repo: 'shop-api', title: 't', body: 'b', head: 'amends/fix', base: 'main' },
      },
    ]);
  });

  it('addLabel and createComment map to the issues API with the repo ref', async () => {
    const octokit = recordingOctokit();
    const client = makeClient(recordingRunner(), octokit);

    await client.addLabel({ issueNumber: 42, label: 'candidate' });
    await client.createComment({ issueNumber: 1301, body: 'evidence attached' });

    expect(octokit.calls).toEqual([
      {
        method: 'issues.addLabels',
        params: { owner: 'example-org', repo: 'shop-api', issue_number: 42, labels: ['candidate'] },
      },
      {
        method: 'issues.createComment',
        params: { owner: 'example-org', repo: 'shop-api', issue_number: 1301, body: 'evidence attached' },
      },
    ]);
  });
});
