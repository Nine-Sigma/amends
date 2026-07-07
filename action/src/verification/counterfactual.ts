/**
 * Counterfactual verification orchestrator (§7.1): prove the artifact FAILS
 * on the original revision and PASSES on the patched revision, both runs
 * identical except the fix diff. Guardrails run BEFORE any execution or
 * write; every command runs under the caller-built zero-secret env (§8.1).
 */

import { join } from 'node:path';

import type { AmendsConfig } from '../config/types.js';
import { checkInvariance, VERIFICATION_CONFIG_SET } from '../guardrails/environment-invariance.js';
import { classifyDiffPaths } from '../guardrails/protected-paths.js';
import type { CommandResult, CommandRunner } from '../utils/exec.js';
import type { FileWriter } from '../utils/fs.js';
import { parseFixDiffPaths } from './diff-paths.js';
import type { RunOutcome, VerificationObservation } from './observation.js';

export interface TestCommand {
  command: string;
  args: readonly string[];
}

export interface CounterfactualRequest {
  repoPath: string;
  originalRevision: string;
  fixDiff: string;
  /** Counterfactual artifact files (repo-relative path -> content), applied to BOTH runs. */
  artifactFiles: Readonly<Record<string, string>>;
  testCommand: TestCommand;
  /** Runner identity for the observation — what the verify stage invoked, open registry. */
  runnerName: string;
  /** Zero-secret env map; build it with buildZeroSecretEnv, never from process.env wholesale. */
  env: Readonly<Record<string, string>>;
  timeoutMs: number;
  config: AmendsConfig;
}

export interface CounterfactualDeps {
  runner: CommandRunner;
  files: FileWriter;
}

export type GuardrailViolationDetail =
  | { kind: 'hard_blocked'; paths: string[] }
  | { kind: 'invariance'; paths: string[] };

export type CounterfactualVerdict =
  | { kind: 'counterfactual'; observation: VerificationObservation }
  /** Artifact passed on the original revision; the patched run never executes. */
  | { kind: 'not_counterfactual'; originalRun: RunOutcome }
  | { kind: 'fix_insufficient'; observation: VerificationObservation; reasons: string[] }
  | { kind: 'guardrail_violation'; violation: GuardrailViolationDetail }
  | { kind: 'cap_exceeded'; fileCount: number; limit: number };

export const ZERO_SECRET_ENV_ALLOWLIST: readonly string[] = ['PATH', 'HOME'];

export const buildZeroSecretEnv = (
  source: Readonly<Record<string, string | undefined>>,
): Record<string, string> => {
  const env: Record<string, string> = {};
  for (const key of ZERO_SECRET_ENV_ALLOWLIST) {
    const value = source[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
};

/** Inside .git on purpose: outside the worktree, so checkout/clean never see it. */
const PATCH_SCRATCH_PATH = '.git/amends-fix.patch';

const MAX_SIGNATURE_OUTPUT = 400;

type Refusal = Extract<CounterfactualVerdict, { kind: 'guardrail_violation' | 'cap_exceeded' }>;

function checkGuardrails(
  fixPaths: string[],
  artifactPaths: string[],
  config: AmendsConfig,
): Refusal | undefined {
  const classification = classifyDiffPaths(fixPaths, config);
  if (classification.kind === 'hard_blocked') {
    return {
      kind: 'guardrail_violation',
      violation: { kind: 'hard_blocked', paths: classification.paths },
    };
  }
  const invariance = checkInvariance(
    { fixDiffPaths: fixPaths, artifactPaths },
    VERIFICATION_CONFIG_SET,
  );
  if (invariance.kind === 'violation') {
    return {
      kind: 'guardrail_violation',
      violation: { kind: 'invariance', paths: invariance.paths },
    };
  }
  if (fixPaths.length > config.limits.max_files_changed) {
    return { kind: 'cap_exceeded', fileCount: fixPaths.length, limit: config.limits.max_files_changed };
  }
  return undefined;
}

const runCommand = (
  request: CounterfactualRequest,
  deps: CounterfactualDeps,
  command: string,
  args: readonly string[],
): Promise<CommandResult> =>
  deps.runner.run({
    command,
    args: [...args],
    cwd: request.repoPath,
    env: { ...request.env },
    timeoutMs: request.timeoutMs,
  });

async function gitOrThrow(
  request: CounterfactualRequest,
  deps: CounterfactualDeps,
  args: readonly string[],
): Promise<void> {
  const result = await runCommand(request, deps, 'git', args);
  if (result.kind === 'timed_out' || result.exitCode !== 0) {
    const detail = result.kind === 'completed' ? result.stderr.trim() : `timed out after ${result.timeoutMs}ms`;
    throw new Error(`git ${args.join(' ')} failed in ${request.repoPath}: ${detail}`);
  }
}

async function resetToOriginal(
  request: CounterfactualRequest,
  deps: CounterfactualDeps,
): Promise<void> {
  await gitOrThrow(request, deps, ['checkout', '--force', request.originalRevision]);
  await gitOrThrow(request, deps, ['clean', '-fd']);
}

async function writeArtifacts(
  request: CounterfactualRequest,
  deps: CounterfactualDeps,
): Promise<void> {
  for (const [path, content] of Object.entries(request.artifactFiles)) {
    await deps.files.write(join(request.repoPath, path), content);
  }
}

const failureSignature = (result: CommandResult): string => {
  if (result.kind === 'timed_out') return `timed_out after ${result.timeoutMs}ms`;
  const output = (result.stderr.trim() || result.stdout.trim()).slice(0, MAX_SIGNATURE_OUTPUT);
  return `exit ${result.exitCode}: ${output}`;
};

async function executeTestRun(
  request: CounterfactualRequest,
  deps: CounterfactualDeps,
): Promise<RunOutcome> {
  const result = await runCommand(
    request,
    deps,
    request.testCommand.command,
    request.testCommand.args,
  );
  if (result.kind === 'completed' && result.exitCode === 0) return { passed: true };
  return { passed: false, failureSignature: failureSignature(result) };
}

type ApplyResult = { applied: true } | { applied: false; failureSignature: string };

async function applyFixDiff(
  request: CounterfactualRequest,
  deps: CounterfactualDeps,
): Promise<ApplyResult> {
  if (request.fixDiff.trim() === '') return { applied: true };
  await deps.files.write(join(request.repoPath, PATCH_SCRATCH_PATH), request.fixDiff);
  const result = await runCommand(request, deps, 'git', ['apply', PATCH_SCRATCH_PATH]);
  if (result.kind === 'completed' && result.exitCode === 0) return { applied: true };
  return { applied: false, failureSignature: `git apply failed: ${failureSignature(result)}` };
}

const buildObservation = (
  request: CounterfactualRequest,
  artifactPaths: string[],
  originalRun: RunOutcome,
  patchedRun: RunOutcome,
): VerificationObservation => ({
  runner: request.runnerName,
  artifactPaths,
  // Phase-1 verify spawns only the test runner and instruments no server,
  // HTTP, or browser signal — recorded conservatively per §7.2.
  serverProcessSpawned: false,
  httpExercised: false,
  browserExercised: false,
  dataPath: 'fixture-only',
  originalRun,
  patchedRun,
});

function insufficiencyReasons(
  originalRun: RunOutcome,
  patchedRun: RunOutcome,
  apply: ApplyResult,
): string[] {
  const reasons = ['artifact_failed_on_patched'];
  if (!apply.applied) reasons.push('fix_diff_apply_failed');
  if (
    !originalRun.passed &&
    !patchedRun.passed &&
    originalRun.failureSignature === patchedRun.failureSignature
  ) {
    reasons.push('failure_signature_unchanged_from_original');
  }
  return reasons;
}

export async function runCounterfactual(
  request: CounterfactualRequest,
  deps: CounterfactualDeps,
): Promise<CounterfactualVerdict> {
  const fixPaths = parseFixDiffPaths(request.fixDiff);
  const artifactPaths = Object.keys(request.artifactFiles);
  const refusal = checkGuardrails(fixPaths, artifactPaths, request.config);
  if (refusal) return refusal;

  await resetToOriginal(request, deps);
  await writeArtifacts(request, deps);
  const originalRun = await executeTestRun(request, deps);
  if (originalRun.passed) return { kind: 'not_counterfactual', originalRun };

  await resetToOriginal(request, deps);
  const apply = await applyFixDiff(request, deps);
  let patchedRun: RunOutcome;
  if (apply.applied) {
    await writeArtifacts(request, deps);
    patchedRun = await executeTestRun(request, deps);
  } else {
    patchedRun = { passed: false, failureSignature: apply.failureSignature };
  }

  const observation = buildObservation(request, artifactPaths, originalRun, patchedRun);
  if (patchedRun.passed) return { kind: 'counterfactual', observation };
  return {
    kind: 'fix_insufficient',
    observation,
    reasons: insufficiencyReasons(originalRun, patchedRun, apply),
  };
}
