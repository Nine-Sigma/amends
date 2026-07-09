/**
 * Publish decision point (product PRD §7.2 / §8.1). Tier 1 → candidate label;
 * review-required paths → label + explicit human-review section, never
 * auto-merge eligible; autonomy issue_only → comment on the work item instead
 * of a PR. Phase 1 computes auto-merge eligibility only — nothing merges.
 */

import type { WorkItem } from '../case-file/types.js';
import type { GitHubClient, PullRequestRef } from '../github/client.js';
import type { DiffClassification } from '../guardrails/protected-paths.js';
import type { Tier } from '../tier/classify.js';
import type { EffectiveAutonomy } from '../tier/resolve-autonomy.js';

/** diagnostic_only never reaches this module — the pipeline refuses upstream as evidence_gate_unmet. */
export type PublishAutonomy = Exclude<EffectiveAutonomy, 'diagnostic_only'>;
/** Tier 0 resolves to diagnostic_only, so it cannot reach publish either. */
export type PublishTier = Exclude<Tier, 0>;
/** hard_blocked diffs are refused before verification ever runs (US-008). */
export type PublishClassification = Exclude<DiffClassification, { kind: 'hard_blocked' }>;

export const CANDIDATE_LABEL = 'candidate';
export const HUMAN_REVIEW_LABEL = 'human-review-required';

export interface OpenPrRequest {
  autonomy: PublishAutonomy;
  tier: PublishTier;
  classification: PublishClassification;
  workItem: WorkItem;
  branch: string;
  base: string;
  title: string;
  body: string;
  /** Validated content only: git-enumerated fix-diff paths plus artifact keys. */
  stagePaths: string[];
}

export type OpenPrResult =
  | { kind: 'pr_opened'; pr: PullRequestRef; labels: string[]; autoMergeEligible: boolean }
  | { kind: 'issue_commented'; issueNumber: number }
  | { kind: 'invalid_work_item'; reason: string };

const humanReviewSection = (paths: string[]): string =>
  [
    '## Human review required',
    '',
    'This diff touches review-required paths (§8.1) and is never auto-merge eligible, regardless of evidence tier:',
    ...paths.map((path) => `- \`${path}\``),
  ].join('\n');

const commentOnWorkItem = async (
  request: OpenPrRequest,
  client: GitHubClient,
): Promise<OpenPrResult> => {
  if (!/^\d+$/.test(request.workItem.id)) {
    return {
      kind: 'invalid_work_item',
      reason: `work_item.id '${request.workItem.id}' is not an issue number`,
    };
  }
  const issueNumber = Number(request.workItem.id);
  await client.createComment({ issueNumber, body: request.body });
  return { kind: 'issue_commented', issueNumber };
};

export const openFixPr = async (
  request: OpenPrRequest,
  client: GitHubClient,
): Promise<OpenPrResult> => {
  if (request.autonomy === 'issue_only') {
    return commentOnWorkItem(request, client);
  }

  const body =
    request.classification.kind === 'review_required'
      ? `${request.body}\n\n${humanReviewSection(request.classification.paths)}`
      : request.body;

  await client.createBranchAndPush({
    branch: request.branch,
    commitMessage: request.title,
    paths: request.stagePaths,
  });
  const pr = await client.openPullRequest({
    title: request.title,
    body,
    head: request.branch,
    base: request.base,
  });

  const labels: string[] = [];
  if (request.tier === 1) {
    labels.push(CANDIDATE_LABEL);
  }
  if (request.classification.kind === 'review_required') {
    labels.push(HUMAN_REVIEW_LABEL);
  }
  for (const label of labels) {
    await client.addLabel({ issueNumber: pr.number, label });
  }

  const autoMergeEligible =
    request.autonomy === 'automerge_eligible' && request.classification.kind !== 'review_required';

  return { kind: 'pr_opened', pr, labels, autoMergeEligible };
};
