/**
 * Narrow GitHub surface for the publish stage. Pipeline modules depend only
 * on the GitHubClient interface; the octokit-backed implementation is a thin
 * mapping constructed only at the entry point (src/index.ts), and every
 * pipeline test uses a recording fake (action/tests/helpers/github-fake.ts).
 */

import type { CommandRunner } from '../utils/exec.js';

export interface BranchPushRequest {
  branch: string;
  commitMessage: string;
}

export interface PullRequestRequest {
  title: string;
  body: string;
  head: string;
  base: string;
}

export interface PullRequestRef {
  number: number;
  url: string;
}

export interface LabelRequest {
  issueNumber: number;
  label: string;
}

export interface CommentRequest {
  issueNumber: number;
  body: string;
}

export interface GitHubClient {
  createBranchAndPush(request: BranchPushRequest): Promise<void>;
  openPullRequest(request: PullRequestRequest): Promise<PullRequestRef>;
  addLabel(request: LabelRequest): Promise<void>;
  createComment(request: CommentRequest): Promise<void>;
}

export interface RepoRef {
  owner: string;
  repo: string;
}

/** Structural subset of an Octokit instance — keeps octokit out of the dependency graph until the entry point provides one. */
export interface OctokitLike {
  rest: {
    pulls: {
      create(params: {
        owner: string;
        repo: string;
        title: string;
        body: string;
        head: string;
        base: string;
      }): Promise<{ data: { number: number; html_url: string } }>;
    };
    issues: {
      addLabels(params: {
        owner: string;
        repo: string;
        issue_number: number;
        labels: string[];
      }): Promise<unknown>;
      createComment(params: {
        owner: string;
        repo: string;
        issue_number: number;
        body: string;
      }): Promise<unknown>;
    };
  };
}

export interface OctokitGitHubClientDeps {
  octokit: OctokitLike;
  runner: CommandRunner;
  repo: RepoRef;
  checkoutPath: string;
  /** Explicit and complete — the git child sees nothing beyond it (§8.1). */
  env: Record<string, string>;
  timeoutMs: number;
}

const runGit = async (deps: OctokitGitHubClientDeps, args: string[]): Promise<void> => {
  const result = await deps.runner.run({
    command: 'git',
    args,
    cwd: deps.checkoutPath,
    env: deps.env,
    timeoutMs: deps.timeoutMs,
  });
  const verb = args[0] ?? 'git';
  if (result.kind === 'timed_out') {
    throw new Error(`git ${verb} timed out after ${String(result.timeoutMs)}ms`);
  }
  if (result.exitCode !== 0) {
    throw new Error(`git ${verb} exited ${String(result.exitCode)}: ${result.stderr}`);
  }
};

export const createOctokitGitHubClient = (deps: OctokitGitHubClientDeps): GitHubClient => ({
  createBranchAndPush: async ({ branch, commitMessage }) => {
    await runGit(deps, ['checkout', '-b', branch]);
    await runGit(deps, ['add', '--all']);
    await runGit(deps, ['commit', '--message', commitMessage]);
    await runGit(deps, ['push', 'origin', branch]);
  },
  openPullRequest: async ({ title, body, head, base }) => {
    const { data } = await deps.octokit.rest.pulls.create({ ...deps.repo, title, body, head, base });
    return { number: data.number, url: data.html_url };
  },
  addLabel: async ({ issueNumber, label }) => {
    await deps.octokit.rest.issues.addLabels({ ...deps.repo, issue_number: issueNumber, labels: [label] });
  },
  createComment: async ({ issueNumber, body }) => {
    await deps.octokit.rest.issues.createComment({ ...deps.repo, issue_number: issueNumber, body });
  },
});
