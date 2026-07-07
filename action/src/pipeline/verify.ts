/**
 * VERIFY sub-stage: release + evidence gates first (§5.4, §7.2), then thin
 * orchestration over runCounterfactual (US-008 owns guardrail ordering and
 * the zero-secret contract), then serialization of the verdict bundle for
 * the publish job. Refusal verdicts are serialized too — publish exits
 * structured from them, it never re-runs verification.
 */

import type { CaseFile } from '../case-file/types.js';
import type { AmendsConfig } from '../config/types.js';
import type { CommandRunner } from '../utils/exec.js';
import type { FileWriter } from '../utils/fs.js';
import { runCounterfactual } from '../verification/counterfactual.js';
import type { TestCommand } from '../verification/counterfactual.js';
import type { FixBundle, VerifyBundle } from './bundle.js';
import type { PipelineVerdict } from './result.js';

export interface VerifyStageRequest {
  caseFile: CaseFile;
  fixBundle: FixBundle;
  repoPath: string;
  /** Zero-secret env map; build it with buildZeroSecretEnv, never from process.env wholesale. */
  env: Readonly<Record<string, string>>;
  timeoutMs: number;
  config: AmendsConfig;
  /** Declared handoff path for the serialized VerifyBundle. */
  bundlePath: string;
}

export interface VerifyStageDeps {
  runner: CommandRunner;
  files: FileWriter;
}

/** validation.test_command is repo-owner-authored case-file data (§8.2) — it runs only under the zero-secret env. */
const parseTestCommand = (caseFile: CaseFile): TestCommand | undefined => {
  const raw = caseFile.validation?.['test_command'];
  if (typeof raw !== 'string' || raw.trim() === '') return undefined;
  const [command, ...args] = raw.trim().split(/\s+/);
  return command === undefined ? undefined : { command, args };
};

async function verifyVerdict(
  request: VerifyStageRequest,
  deps: VerifyStageDeps,
): Promise<PipelineVerdict> {
  const { caseFile, fixBundle } = request;
  const revision = caseFile.release.revision;
  if (caseFile.release.resolution.status === 'unresolved' || revision === null) {
    return { kind: 'release_unresolved', declared: caseFile.release.declared };
  }

  const missing: string[] = [];
  if (Object.keys(fixBundle.artifactFiles).length === 0) missing.push('counterfactual_artifact');
  const testCommand = parseTestCommand(caseFile);
  if (testCommand === undefined) missing.push('validation.test_command');
  if (testCommand === undefined || missing.length > 0) {
    return { kind: 'evidence_gate_unmet', missing };
  }

  return runCounterfactual(
    {
      repoPath: request.repoPath,
      originalRevision: revision,
      fixDiff: fixBundle.fixDiff,
      artifactFiles: fixBundle.artifactFiles,
      testCommand,
      runnerName: testCommand.command,
      env: request.env,
      timeoutMs: request.timeoutMs,
      config: request.config,
    },
    deps,
  );
}

export async function runVerifyStage(
  request: VerifyStageRequest,
  deps: VerifyStageDeps,
): Promise<VerifyBundle> {
  const verdict = await verifyVerdict(request, deps);
  const bundle: VerifyBundle = { verdict };
  await deps.files.write(request.bundlePath, JSON.stringify(bundle, null, 2));
  return bundle;
}
