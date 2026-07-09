/**
 * Action entry point — the ONLY module that reads action inputs and process
 * env. Everything below it receives constructed dependencies (config,
 * clients, runner, file boundaries) explicitly.
 */

import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { Octokit } from '@octokit/rest';

import { parseCaseFile } from './case-file/parse.js';
import type { CaseFile } from './case-file/types.js';
import { loadConfig } from './config/load-config.js';
import type { AmendsConfig } from './config/types.js';
import { createOctokitGitHubClient } from './github/client.js';
import { parseFixBundle, parseVerifyBundle } from './pipeline/bundle.js';
import type { FixBundle, VerifyBundle } from './pipeline/bundle.js';
import { runFixStage } from './pipeline/fix.js';
import { runPublishStage } from './pipeline/publish.js';
import { summarizePipelineResult } from './pipeline/result.js';
import { runVerifyStage } from './pipeline/verify.js';
import {
  buildFixStageEnv,
  buildPublishGitEnv,
  buildZeroSecretEnv,
  DEFAULT_COMMIT_IDENTITY,
} from './utils/env.js';
import { createCommandRunner } from './utils/exec.js';
import { createFileReader, createFileWriter } from './utils/fs.js';
import type { ParseError } from './utils/narrow.js';

type EnvMap = Readonly<Record<string, string | undefined>>;

const STAGES = ['fix', 'verify', 'publish'] as const;
export type Stage = (typeof STAGES)[number];

export interface ActionInputs {
  stage: Stage;
  caseFilePath: string;
  configPath: string;
  fixBundlePath: string;
  verifyBundlePath: string;
  promptPath: string;
  adapterCommand: string;
  adapterArgs: string[];
  /** Env var names (never values) the workflow explicitly grants to the adapter child. */
  adapterSecretEnv: string[];
  model: string;
  base: string;
  checkoutPath: string;
  committerName: string;
  committerEmail: string;
  timeoutMs: number;
}

export type ReadInputsResult =
  | { ok: true; inputs: ActionInputs }
  | { ok: false; errors: ParseError[] };

const DEFAULT_TIMEOUT_MS = 600_000;

/** GitHub exposes `with:` inputs as INPUT_<NAME> env vars (dashes preserved). */
export const readActionInputs = (env: EnvMap): ReadInputsResult => {
  const input = (name: string): string | undefined => {
    const value = env[`INPUT_${name.toUpperCase()}`];
    return value === undefined || value === '' ? undefined : value;
  };
  const errors: ParseError[] = [];

  const stageValue = input('stage');
  const stage = STAGES.find((candidate) => candidate === stageValue);
  if (stage === undefined) {
    errors.push({ path: 'stage', reason: "expected one of 'fix' | 'verify' | 'publish'" });
  }
  const workspace = env['GITHUB_WORKSPACE'];
  if (workspace === undefined) {
    errors.push({ path: 'GITHUB_WORKSPACE', reason: 'required environment variable is missing' });
  }
  const caseFile = input('case-file');
  if (caseFile === undefined) {
    errors.push({ path: 'case-file', reason: 'required input is missing' });
  }
  const adapterCommand = input('adapter-command') ?? '';
  const model = input('model') ?? '';
  if (stage === 'fix' && adapterCommand === '') {
    errors.push({ path: 'adapter-command', reason: 'required input is missing for stage fix' });
  }
  if (stage === 'fix' && model === '') {
    errors.push({ path: 'model', reason: 'required input is missing for stage fix' });
  }
  const timeoutValue = input('timeout-ms');
  const timeoutMs = timeoutValue === undefined ? DEFAULT_TIMEOUT_MS : Number(timeoutValue);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    errors.push({ path: 'timeout-ms', reason: 'expected a positive number of milliseconds' });
  }

  if (errors.length > 0 || stage === undefined || workspace === undefined || caseFile === undefined) {
    return { ok: false, errors };
  }
  const inWorkspace = (path: string): string => resolve(workspace, path);
  return {
    ok: true,
    inputs: {
      stage,
      caseFilePath: inWorkspace(caseFile),
      configPath: inWorkspace(input('config-path') ?? 'amends.yml'),
      fixBundlePath: inWorkspace(input('fix-bundle') ?? 'amends-out/fix-bundle.json'),
      verifyBundlePath: inWorkspace(input('verify-bundle') ?? 'amends-out/verify-bundle.json'),
      // Out of the worktree by construction, so the prompt (which embeds
      // case-file content) can never be swept into the fix diff (1.4).
      promptPath: resolve(env['RUNNER_TEMP'] ?? tmpdir(), input('prompt-path') ?? 'amends/prompt.md'),
      adapterCommand,
      adapterArgs: (input('adapter-args') ?? '').split(/\s+/).filter((arg) => arg !== ''),
      adapterSecretEnv: (input('adapter-secret-env') ?? '')
        .split(',')
        .map((key) => key.trim())
        .filter((key) => key !== ''),
      model,
      base: input('base') ?? 'main',
      checkoutPath: workspace,
      committerName: input('committer-name') ?? DEFAULT_COMMIT_IDENTITY.name,
      committerEmail: input('committer-email') ?? DEFAULT_COMMIT_IDENTITY.email,
      timeoutMs,
    },
  };
};

/** Entry-boundary fault: printed structured by main(); never used for stage control flow. */
class EntryFault extends Error {
  constructor(message: string, errors: ParseError[] = []) {
    super(errors.length > 0 ? `${message}: ${JSON.stringify(errors)}` : message);
  }
}

const readJson = async (path: string): Promise<unknown> => {
  const content = await readFile(path, 'utf8');
  try {
    return JSON.parse(content) as unknown;
  } catch (error) {
    throw new EntryFault(`${path} is not valid JSON: ${String(error)}`);
  }
};

const loadCaseFileAt = async (path: string): Promise<CaseFile> => {
  const parsed = parseCaseFile(await readJson(path));
  if (!parsed.ok) throw new EntryFault(`case file ${path} rejected`, parsed.errors);
  return parsed.caseFile;
};

const loadConfigAt = async (path: string): Promise<AmendsConfig> => {
  const content = await readFile(path, 'utf8').catch(() => undefined);
  const result = loadConfig(content);
  if (!result.ok) throw new EntryFault(`config ${path} rejected`, result.errors);
  return result.config;
};

const loadFixBundleAt = async (path: string): Promise<FixBundle> => {
  const parsed = parseFixBundle(await readJson(path));
  if (!parsed.ok) throw new EntryFault(`fix bundle ${path} rejected`, parsed.errors);
  return parsed.bundle;
};

const loadVerifyBundleAt = async (path: string): Promise<VerifyBundle> => {
  const parsed = parseVerifyBundle(await readJson(path));
  if (!parsed.ok) throw new EntryFault(`verify bundle ${path} rejected`, parsed.errors);
  return parsed.bundle;
};

interface DispatchOutcome {
  ok: boolean;
  result: Record<string, unknown>;
}

const dispatchFix = async (inputs: ActionInputs, env: EnvMap): Promise<DispatchOutcome> => {
  const caseFile = await loadCaseFileAt(inputs.caseFilePath);
  const template = await readFile(resolve(import.meta.dirname, '../prompts/fix-pass.md'), 'utf8');
  const result = await runFixStage(
    {
      caseFile,
      invocation: {
        command: inputs.adapterCommand,
        args: inputs.adapterArgs,
        input: {
          checkout_path: inputs.checkoutPath,
          case_file_path: inputs.caseFilePath,
          model_config: { model: inputs.model },
        },
        // Model secrets reach the fix job only via the explicit adapter-secret-env grant (§8.1).
        env: buildFixStageEnv(env, inputs.adapterSecretEnv),
        timeoutMs: inputs.timeoutMs,
      },
      promptTemplate: template,
      promptPath: inputs.promptPath,
      bundlePath: inputs.fixBundlePath,
    },
    { runner: createCommandRunner(), files: createFileWriter(), reader: createFileReader() },
  );
  if (result.kind === 'fix_complete') {
    return { ok: true, result: { stage: 'fix', kind: result.kind, bundlePath: inputs.fixBundlePath } };
  }
  return { ok: false, result: { stage: 'fix', ...result } };
};

const dispatchVerify = async (inputs: ActionInputs, env: EnvMap): Promise<DispatchOutcome> => {
  const bundle = await runVerifyStage(
    {
      caseFile: await loadCaseFileAt(inputs.caseFilePath),
      fixBundle: await loadFixBundleAt(inputs.fixBundlePath),
      repoPath: inputs.checkoutPath,
      env: buildZeroSecretEnv(env),
      timeoutMs: inputs.timeoutMs,
      config: await loadConfigAt(inputs.configPath),
      bundlePath: inputs.verifyBundlePath,
    },
    { runner: createCommandRunner(), files: createFileWriter() },
  );
  return {
    ok: true,
    result: {
      stage: 'verify',
      kind: 'verify_complete',
      verdict: bundle.verdict.kind,
      bundlePath: inputs.verifyBundlePath,
    },
  };
};

const requireEnv = (env: EnvMap, key: string): string => {
  const value = env[key];
  if (value === undefined || value === '') {
    throw new EntryFault(`required environment variable ${key} is missing`);
  }
  return value;
};

const dispatchPublish = async (inputs: ActionInputs, env: EnvMap): Promise<DispatchOutcome> => {
  const repoFull = requireEnv(env, 'GITHUB_REPOSITORY');
  const [owner, repo] = repoFull.split('/');
  if (owner === undefined || repo === undefined || repo === '') {
    throw new EntryFault(`GITHUB_REPOSITORY '${repoFull}' is not owner/repo`);
  }
  const gitEnv = buildPublishGitEnv(env, {
    name: inputs.committerName,
    email: inputs.committerEmail,
  });
  const github = createOctokitGitHubClient({
    octokit: new Octokit({ auth: requireEnv(env, 'GITHUB_TOKEN') }),
    runner: createCommandRunner(),
    repo: { owner, repo },
    checkoutPath: inputs.checkoutPath,
    env: gitEnv,
    timeoutMs: inputs.timeoutMs,
  });
  const runLink = `${env['GITHUB_SERVER_URL'] ?? 'https://github.com'}/${repoFull}/actions/runs/${env['GITHUB_RUN_ID'] ?? 'unknown'}`;
  const result = await runPublishStage(
    {
      caseFile: await loadCaseFileAt(inputs.caseFilePath),
      fixBundle: await loadFixBundleAt(inputs.fixBundlePath),
      verifyBundle: await loadVerifyBundleAt(inputs.verifyBundlePath),
      config: await loadConfigAt(inputs.configPath),
      repoPath: inputs.checkoutPath,
      base: inputs.base,
      // Both runs execute inside the single verify job, so they share one run link.
      verificationRunLinks: { originalRun: runLink, patchedRun: runLink },
      env: gitEnv,
      timeoutMs: inputs.timeoutMs,
    },
    { github, runner: createCommandRunner(), files: createFileWriter() },
  );
  if (result.kind === 'invalid_branch_ref') {
    return { ok: false, result: { stage: 'publish', ...result } };
  }
  return {
    ok: result.kind === 'published',
    result: { stage: 'publish', ...result, summary: summarizePipelineResult(result) },
  };
};

export const runAction = async (env: EnvMap): Promise<DispatchOutcome> => {
  const parsed = readActionInputs(env);
  if (!parsed.ok) {
    return { ok: false, result: { kind: 'invalid_inputs', errors: parsed.errors } };
  }
  switch (parsed.inputs.stage) {
    case 'fix':
      return dispatchFix(parsed.inputs, env);
    case 'verify':
      return dispatchVerify(parsed.inputs, env);
    case 'publish':
      return dispatchPublish(parsed.inputs, env);
  }
};

const isDirectInvocation = (argv1: string | undefined): boolean =>
  argv1 !== undefined && import.meta.url === pathToFileURL(argv1).href;

if (isDirectInvocation(process.argv[1])) {
  runAction(process.env)
    .then((outcome) => {
      process.stdout.write(`${JSON.stringify(outcome.result, null, 2)}\n`);
      process.exitCode = outcome.ok ? 0 : 1;
    })
    .catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
