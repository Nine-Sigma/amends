/**
 * Recording GitHubClient fake for pipeline tests (US-009..US-011). Records
 * every write call so refusal-path tests can assert zero GitHub writes.
 * Test-only: excluded from the package build (tsconfig.build.json).
 */

import type {
  BranchPushRequest,
  CommentRequest,
  GitHubClient,
  LabelsRequest,
  PullRequestRequest,
} from '../../src/github/client.js';

export interface RecordingGitHub extends GitHubClient {
  readonly branchPushes: BranchPushRequest[];
  readonly pullRequests: PullRequestRequest[];
  readonly labels: LabelsRequest[];
  readonly comments: CommentRequest[];
}

export const createRecordingGitHub = (): RecordingGitHub => {
  const branchPushes: BranchPushRequest[] = [];
  const pullRequests: PullRequestRequest[] = [];
  const labels: LabelsRequest[] = [];
  const comments: CommentRequest[] = [];
  let nextPrNumber = 101;
  return {
    branchPushes,
    pullRequests,
    labels,
    comments,
    createBranchAndPush: (request) => {
      branchPushes.push(request);
      return Promise.resolve();
    },
    openPullRequest: (request) => {
      pullRequests.push(request);
      const number = nextPrNumber;
      nextPrNumber += 1;
      return Promise.resolve({
        number,
        url: `https://github.example/example-org/shop-api/pull/${String(number)}`,
      });
    },
    addLabels: (request) => {
      labels.push(request);
      return Promise.resolve();
    },
    createComment: (request) => {
      comments.push(request);
      return Promise.resolve();
    },
  };
};
