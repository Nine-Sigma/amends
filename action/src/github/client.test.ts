import { describe, expect, it } from 'vitest';
import type { CommandRequest, CommandResult, CommandRunner } from '../utils/exec.js';
import type { OctokitLike } from './client.js';
import { createOctokitGitHubClient } from './client.js';

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
  it('createBranchAndPush runs checkout, add, commit, push in the checkout with the explicit env', async () => {
    const runner = recordingRunner();
    const client = makeClient(runner, recordingOctokit());

    await client.createBranchAndPush({ branch: 'amends/fix-1301', commitMessage: 'fix: pay route' });

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
    expect(runner.requests[3]?.args).toEqual(['push', 'origin', 'amends/fix-1301']);
  });

  it('createBranchAndPush rejects on a nonzero git exit (environment fault)', async () => {
    const runner = recordingRunner({ kind: 'completed', exitCode: 128, stdout: '', stderr: 'fatal: not a git repository' });
    const client = makeClient(runner, recordingOctokit());

    await expect(
      client.createBranchAndPush({ branch: 'b', commitMessage: 'm' }),
    ).rejects.toThrow(/exited 128/);
  });

  it('createBranchAndPush rejects on timeout', async () => {
    const runner = recordingRunner({ kind: 'timed_out', timeoutMs: 30_000 });
    const client = makeClient(runner, recordingOctokit());

    await expect(
      client.createBranchAndPush({ branch: 'b', commitMessage: 'm' }),
    ).rejects.toThrow(/timed out/);
  });

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
