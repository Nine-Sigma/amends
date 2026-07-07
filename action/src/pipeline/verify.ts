/**
 * VERIFY sub-stage: thin orchestration over runCounterfactual (US-008 owns
 * guardrail ordering and the zero-secret contract) plus serialization of the
 * verdict bundle for the publish job. Refusal verdicts are serialized too —
 * publish exits structured from them, it never re-runs verification.
 */

import type { AmendsConfig } from '../config/types.js';
import type { CommandRunner } from '../utils/exec.js';
import type { FileWriter } from '../utils/fs.js';
import { runCounterfactual } from '../verification/counterfactual.js';
import type { TestCommand } from '../verification/counterfactual.js';
import type { FixBundle, VerifyBundle } from './bundle.js';

export interface VerifyStageRequest {
  fixBundle: FixBundle;
  repoPath: string;
  originalRevision: string;
  testCommand: TestCommand;
  /** Runner identity for the observation — what the verify stage invokes, open registry. */
  runnerName: string;
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

export async function runVerifyStage(
  request: VerifyStageRequest,
  deps: VerifyStageDeps,
): Promise<VerifyBundle> {
  const verdict = await runCounterfactual(
    {
      repoPath: request.repoPath,
      originalRevision: request.originalRevision,
      fixDiff: request.fixBundle.fixDiff,
      artifactFiles: request.fixBundle.artifactFiles,
      testCommand: request.testCommand,
      runnerName: request.runnerName,
      env: request.env,
      timeoutMs: request.timeoutMs,
      config: request.config,
    },
    deps,
  );
  const bundle: VerifyBundle = { verdict };
  await deps.files.write(request.bundlePath, JSON.stringify(bundle, null, 2));
  return bundle;
}
