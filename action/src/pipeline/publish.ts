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
import type { DiffClassification } from '../guardrails/protected-paths.js';
import { composePrBody } from '../pr/compose-body.js';
import type { VerificationRunLinks } from '../pr/compose-body.js';
import { openFixPr } from '../pr/open-pr.js';
import { classifyTier } from '../tier/classify.js';
import { resolveAutonomy } from '../tier/resolve-autonomy.js';
import { applyFixDiff, enumerateFixDiffPaths } from '../utils/apply-fix-diff.js';
import type { CommandRunner } from '../utils/exec.js';
import type { FileWriter } from '../utils/fs.js';
import type { FixBundle, VerifyBundle } from './bundle.js';
import type { PipelineResult } from './result.js';

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
  /** Success plus every gate refusal — refusal verdicts pass through unwrapped. */
  | PipelineResult
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

type GuardrailRecheck =
  | { kind: 'refused'; result: PublishStageResult }
  | {
      kind: 'clear';
      paths: string[];
      classification: Exclude<DiffClassification, { kind: 'hard_blocked' }>;
    };

/** Defensive re-check: verify already refuses hard-blocked diffs before running (US-008). */
async function recheckGuardrails(
  request: PublishStageRequest,
  deps: PublishStageDeps,
): Promise<GuardrailRecheck> {
  const enumerated = await enumerateFixDiffPaths(
    {
      repoPath: request.repoPath,
      fixDiff: request.fixBundle.fixDiff,
      env: request.env,
      timeoutMs: request.timeoutMs,
    },
    deps.runner,
    deps.files,
  );
  if (!enumerated.ok) {
    return {
      kind: 'refused',
      result: {
        kind: 'guardrail_violation',
        violation: { kind: 'unenumerable_diff', reason: enumerated.reason },
      },
    };
  }
  const classification = classifyDiffPaths(enumerated.paths, request.config);
  if (classification.kind === 'hard_blocked') {
    return {
      kind: 'refused',
      result: {
        kind: 'guardrail_violation',
        violation: { kind: 'hard_blocked', paths: classification.paths },
      },
    };
  }
  return { kind: 'clear', paths: enumerated.paths, classification };
}

export async function runPublishStage(
  request: PublishStageRequest,
  deps: PublishStageDeps,
): Promise<PublishStageResult> {
  const verdict = request.verifyBundle.verdict;
  if (verdict.kind !== 'counterfactual') {
    return verdict;
  }

  const tier = classifyTier(verdict.observation);
  const tierLevel = tier.tier;
  const resolution = resolveAutonomy(request.config.mode, tierLevel);
  const autonomy = resolution.autonomy;
  if (tierLevel === 0 || autonomy === 'diagnostic_only') {
    return { kind: 'evidence_gate_unmet', missing: tier.reasons };
  }

  const recheck = await recheckGuardrails(request, deps);
  if (recheck.kind === 'refused') return recheck.result;
  const classification = recheck.classification;

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
      stagePaths: [
        ...new Set([...recheck.paths, ...Object.keys(request.fixBundle.artifactFiles)]),
      ],
    },
    deps.github,
  );
  return { kind: 'published', outcome };
}
