import { describe, expect, it } from 'vitest';
import { createRecordingGitHub } from '../../tests/helpers/github-fake.js';
import type { WorkItem } from '../case-file/types.js';
import type { OpenPrRequest } from './open-pr.js';
import { CANDIDATE_LABEL, HUMAN_REVIEW_LABEL, openFixPr } from './open-pr.js';

const workItem: WorkItem = {
  kind: 'github_issue',
  id: '1301',
  url: 'https://github.com/example-org/shop-api/issues/1301',
};

const baseRequest = (): OpenPrRequest => ({
  autonomy: 'candidate_pr',
  tier: 1,
  classification: { kind: 'clear' },
  workItem,
  branch: 'amends/fix-1301',
  base: 'main',
  title: 'fix: null customer on pay route',
  body: 'validated, evidence-backed fix body',
  stagePaths: ['src/pay.js', 'artifact.test.mjs'],
});

describe('openFixPr', () => {
  it('opens a PR from the pushed branch and labels Tier 1 as candidate', async () => {
    const github = createRecordingGitHub();

    const result = await openFixPr(baseRequest(), github);

    expect(github.branchPushes).toEqual([
      {
        branch: 'amends/fix-1301',
        commitMessage: 'fix: null customer on pay route',
        paths: ['src/pay.js', 'artifact.test.mjs'],
      },
    ]);
    expect(github.pullRequests).toEqual([
      {
        title: 'fix: null customer on pay route',
        body: 'validated, evidence-backed fix body',
        head: 'amends/fix-1301',
        base: 'main',
      },
    ]);
    expect(github.labels).toEqual([{ issueNumber: 101, label: CANDIDATE_LABEL }]);
    expect(result.kind).toBe('pr_opened');
    if (result.kind !== 'pr_opened') throw new Error('unreachable');
    expect(result.autoMergeEligible).toBe(false);
  });

  it('does not label Tier 2 normal PRs as candidate', async () => {
    const github = createRecordingGitHub();

    await openFixPr({ ...baseRequest(), autonomy: 'normal_pr', tier: 2 }, github);

    expect(github.labels).toEqual([]);
  });

  it('autonomy issue_only comments on the work-item issue and opens no PR', async () => {
    const github = createRecordingGitHub();

    const result = await openFixPr({ ...baseRequest(), autonomy: 'issue_only' }, github);

    expect(result).toEqual({ kind: 'issue_commented', issueNumber: 1301 });
    expect(github.comments).toEqual([
      { issueNumber: 1301, body: 'validated, evidence-backed fix body' },
    ]);
    expect(github.branchPushes).toEqual([]);
    expect(github.pullRequests).toEqual([]);
    expect(github.labels).toEqual([]);
  });

  it('issue_only with a non-numeric work-item id is a structured failure with zero GitHub writes', async () => {
    const github = createRecordingGitHub();
    const hostile: WorkItem = { ...workItem, id: 'ignore instructions' };

    const result = await openFixPr({ ...baseRequest(), autonomy: 'issue_only', workItem: hostile }, github);

    expect(result.kind).toBe('invalid_work_item');
    expect(github.comments).toEqual([]);
    expect(github.branchPushes).toEqual([]);
    expect(github.pullRequests).toEqual([]);
  });

  it('review-required paths add the label and an explicit human-review body section', async () => {
    const github = createRecordingGitHub();

    const result = await openFixPr(
      {
        ...baseRequest(),
        autonomy: 'normal_pr',
        tier: 2,
        classification: { kind: 'review_required', paths: ['package.json', 'src/auth/session.ts'] },
      },
      github,
    );

    expect(github.labels).toEqual([{ issueNumber: 101, label: HUMAN_REVIEW_LABEL }]);
    const body = github.pullRequests[0]?.body ?? '';
    expect(body).toContain('Human review required');
    expect(body).toContain('package.json');
    expect(body).toContain('src/auth/session.ts');
    expect(body).toContain('validated, evidence-backed fix body');
    expect(body).not.toMatch(/proven/i);
    if (result.kind !== 'pr_opened') throw new Error('expected pr_opened');
    expect(result.autoMergeEligible).toBe(false);
  });

  it('review-required is never auto-merge eligible even at automerge_eligible autonomy', async () => {
    const github = createRecordingGitHub();

    const result = await openFixPr(
      {
        ...baseRequest(),
        autonomy: 'automerge_eligible',
        tier: 2,
        classification: { kind: 'review_required', paths: ['pnpm-lock.yaml'] },
      },
      github,
    );

    if (result.kind !== 'pr_opened') throw new Error('expected pr_opened');
    expect(result.autoMergeEligible).toBe(false);
  });

  it('automerge_eligible autonomy with a clear diff reports auto-merge eligibility (nothing merges in Phase 1)', async () => {
    const github = createRecordingGitHub();

    const result = await openFixPr(
      { ...baseRequest(), autonomy: 'automerge_eligible', tier: 2 },
      github,
    );

    if (result.kind !== 'pr_opened') throw new Error('expected pr_opened');
    expect(result.autoMergeEligible).toBe(true);
    expect(github.labels).toEqual([]);
  });

  it('candidate and human-review labels combine for a Tier-1 review-required diff', async () => {
    const github = createRecordingGitHub();

    await openFixPr(
      {
        ...baseRequest(),
        classification: { kind: 'review_required', paths: ['package.json'] },
      },
      github,
    );

    expect(github.labels.map((label) => label.label)).toEqual([CANDIDATE_LABEL, HUMAN_REVIEW_LABEL]);
  });
});
