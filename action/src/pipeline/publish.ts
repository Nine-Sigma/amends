/**
 * PUBLISH sub-stage: gate on the verify verdict, classify evidence
 * mechanically (US-005), materialize the validated fix in a fresh checkout,
 * and open the PR / comment through the narrow GitHub client (US-009).
 * Precondition: the working tree is a clean checkout at the original
 * revision (a fresh job checkout in the reference workflow).
 */

import { join } from 'node:path';

import type { CaseFile } from '../case-file/types.js';
import type { AmendsConfig } from '../config/types.js';
import type { GitHubClient } from '../github/client.js';
import { classifyDiffPaths } from '../guardrails/protected-paths.js';
import { composePrBody } from '../pr/compose-body.js';
import type { VerificationRunLinks } from '../pr/compose-body.js';
import { openFixPr } from '../pr/open-pr.js';
import type { OpenPrResult } from '../pr/open-pr.js';
import { classifyTier } from '../tier/classify.js';
import { resolveAutonomy } from '../tier/resolve-autonomy.js';
import { applyFixDiff } from '../utils/apply-fix-diff.js';
import type { CommandRunner } from '../utils/exec.js';
import type { FileWriter } from '../utils/fs.js';
import type { CounterfactualVerdict } from '../verification/counterfactual.js';
import { parseFixDiffPaths } from '../verification/diff-paths.js';
import type { FixBundle, VerifyBundle } from './bundle.js';

export interface PublishStageRequest {
  caseFile: CaseFile;
  fixBundle: FixBundle;
  verifyBundle: VerifyBundle;
  config: AmendsConfig;
  repoPath: string;
  base: string;
  verificationRunLinks: VerificationRunLinks;
  env: Readonly<Record<string, string>>;
  timeoutMs: number;
}

export interface PublishStageDeps {
  github: GitHubClient;
  runner: CommandRunner;
  files: FileWriter;
}

export type PublishStageResult =
  | { kind: 'published'; outcome: OpenPrResult }
  /** The verify verdict was a refusal; nothing is written to GitHub. */
  | { kind: 'not_publishable'; verdictKind: Exclude<CounterfactualVerdict['kind'], 'counterfactual'> }
  /** Tier 0 / diagnostic_only: the evidence gate is unmet (§7.2). */
  | { kind: 'evidence_gate_unmet'; reasons: string[] }
  /** Defensive: verify refuses hard-blocked diffs before running (US-008). */
  | { kind: 'hard_blocked_diff'; paths: string[] }
  /** branch_ref is adapter output (§8.1) — validated before use as a git ref. */
  | { kind: 'invalid_branch_ref'; branchRef: string };

const BRANCH_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

async function materializeFix(
  request: PublishStageRequest,
  deps: PublishStageDeps,
): Promise<void> {
  const apply = await applyFixDiff(
    {
      repoPath: request.repoPath,
      fixDiff: request.fixBundle.fixDiff,
      env: request.env,
      timeoutMs: request.timeoutMs,
    },
    deps.runner,
    deps.files,
  );
  if (!apply.applied) {
    // Verify proved this diff applies; a failure here is an environment fault.
    throw new Error(`fix diff did not apply in the publish checkout: ${apply.failureSignature}`);
  }
  for (const [path, content] of Object.entries(request.fixBundle.artifactFiles)) {
    await deps.files.write(join(request.repoPath, path), content);
  }
}

const prTitle = (caseFile: CaseFile): string =>
  `Amends: evidence-backed fix for ${caseFile.work_item.kind} ${caseFile.work_item.id}`;

export async function runPublishStage(
  request: PublishStageRequest,
  deps: PublishStageDeps,
): Promise<PublishStageResult> {
  const verdict = request.verifyBundle.verdict;
  if (verdict.kind !== 'counterfactual') {
    return { kind: 'not_publishable', verdictKind: verdict.kind };
  }

  const tier = classifyTier(verdict.observation);
  const tierLevel = tier.tier;
  const resolution = resolveAutonomy(request.config.mode, tierLevel);
  const autonomy = resolution.autonomy;
  if (tierLevel === 0 || autonomy === 'diagnostic_only') {
    return { kind: 'evidence_gate_unmet', reasons: tier.reasons };
  }

  const classification = classifyDiffPaths(parseFixDiffPaths(request.fixBundle.fixDiff), request.config);
  if (classification.kind === 'hard_blocked') {
    return { kind: 'hard_blocked_diff', paths: classification.paths };
  }

  const branch = request.fixBundle.adapterResult.branch_ref;
  if (!BRANCH_REF_PATTERN.test(branch)) {
    return { kind: 'invalid_branch_ref', branchRef: branch };
  }

  if (autonomy !== 'issue_only') {
    await materializeFix(request, deps);
  }

  const body = composePrBody({
    caseFile: request.caseFile,
    observation: verdict.observation,
    tier,
    autonomy: resolution,
    verificationRunLinks: request.verificationRunLinks,
    agentIdentity: request.fixBundle.agentIdentity,
  });
  const outcome = await openFixPr(
    {
      autonomy,
      tier: tierLevel,
      classification,
      workItem: request.caseFile.work_item,
      branch,
      base: request.base,
      title: prTitle(request.caseFile),
      body,
    },
    deps.github,
  );
  return { kind: 'published', outcome };
}
