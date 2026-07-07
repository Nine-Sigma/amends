/**
 * Shared driver for in-process fix -> verify -> publish integration tests
 * (US-010 happy path, US-011 refusal paths). Runs the real stages over a
 * temp-git repo with the scripted fake adapter — no network, no real GitHub.
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { parseCaseFile } from '../../src/case-file/parse.js';
import type { CaseFile } from '../../src/case-file/types.js';
import { loadConfig } from '../../src/config/load-config.js';
import type { AmendsConfig } from '../../src/config/types.js';
import type { GitHubClient } from '../../src/github/client.js';
import { parseFixBundle, parseVerifyBundle } from '../../src/pipeline/bundle.js';
import type { FixBundle, VerifyBundle } from '../../src/pipeline/bundle.js';
import { runFixStage } from '../../src/pipeline/fix.js';
import { runPublishStage } from '../../src/pipeline/publish.js';
import type { PublishStageResult } from '../../src/pipeline/publish.js';
import { runVerifyStage } from '../../src/pipeline/verify.js';
import { createCommandRunner } from '../../src/utils/exec.js';
import type { CommandRequest, CommandRunner } from '../../src/utils/exec.js';
import { createFileReader, createFileWriter } from '../../src/utils/fs.js';
import { buildZeroSecretEnv } from '../../src/verification/counterfactual.js';
import type { FakeAdapterScenario } from './fake-adapter.js';
import { stageScenarioAdapter } from './scenario-adapter.js';
import { createTempGitRepo } from './temp-git.js';
import type { TempGitRepo } from './temp-git.js';

export const FIXTURES_DIR = resolve(import.meta.dirname, '../../../schema/examples');
const TEMPLATE_PATH = resolve(import.meta.dirname, '../../prompts/fix-pass.md');

export const PIPELINE_RUN_LINKS = {
  originalRun: 'https://github.example/example-org/shop-api/actions/runs/9001',
  patchedRun: 'https://github.example/example-org/shop-api/actions/runs/9002',
};

export const loadFixtureCaseFile = async (fixtureName: string): Promise<CaseFile> => {
  const raw: unknown = JSON.parse(await readFile(join(FIXTURES_DIR, fixtureName), 'utf8'));
  const parsed = parseCaseFile(raw);
  if (!parsed.ok) throw new Error(`fixture ${fixtureName} must parse`);
  return parsed.caseFile;
};

/**
 * Clone bound to the temp repo: release.revision points at the planted bug
 * commit and validation.test_command runs the repo's node artifact — the two
 * case-file fields the verify stage derives its runs from.
 */
export const bindCaseFileToRepo = (caseFile: CaseFile, repo: TempGitRepo): CaseFile => ({
  ...caseFile,
  release: { ...caseFile.release, revision: repo.bugCommit },
  validation: {
    ...(caseFile.validation ?? {}),
    test_command: [repo.testCommand.command, ...repo.testCommand.args].join(' '),
  },
});

export const defaultConfig = (): AmendsConfig => {
  const result = loadConfig(undefined);
  if (!result.ok) throw new Error('defaults must load');
  return result.config;
};

export const recordingRunner = (): { runner: CommandRunner; calls: CommandRequest[] } => {
  const calls: CommandRequest[] = [];
  return {
    calls,
    runner: {
      run: (request) => {
        calls.push(request);
        return Promise.resolve({ kind: 'completed', exitCode: 0, stdout: '', stderr: '' });
      },
    },
  };
};

export interface PipelineHarness {
  repo: TempGitRepo;
  outDir: string;
  runFix(scenario: FakeAdapterScenario, caseFile: CaseFile): Promise<FixBundle>;
  runVerify(caseFile: CaseFile, fixBundle: FixBundle, runner: CommandRunner): Promise<VerifyBundle>;
  runPublish(
    caseFile: CaseFile,
    fixBundle: FixBundle,
    verifyBundle: VerifyBundle,
    github: GitHubClient,
    runner?: CommandRunner,
  ): Promise<PublishStageResult>;
  resetToFreshCheckout(): Promise<void>;
  cleanup(): Promise<void>;
}

const stageRunFix = async (
  repo: TempGitRepo,
  outDir: string,
  scenario: FakeAdapterScenario,
  caseFile: CaseFile,
): Promise<FixBundle> => {
  const staged = await stageScenarioAdapter(repo, scenario);
  const template = await readFile(TEMPLATE_PATH, 'utf8');
  const fixResult = await runFixStage(
    {
      caseFile,
      invocation: {
        command: 'fake-adapter',
        args: [],
        input: {
          checkout_path: repo.repoPath,
          case_file_path: join(FIXTURES_DIR, 'node-api-500.json'),
          model_config: { model: 'fake-model' },
        },
        env: {},
        timeoutMs: 10_000,
      },
      promptTemplate: template,
      promptPath: join(outDir, 'prompt.md'),
      bundlePath: join(outDir, 'fix-bundle.json'),
    },
    { runner: staged.adapterRunner, files: createFileWriter(), reader: createFileReader() },
  );
  if (fixResult.kind !== 'fix_complete') {
    throw new Error(`fix stage must complete, got ${fixResult.kind}`);
  }
  const raw: unknown = JSON.parse(await readFile(join(outDir, 'fix-bundle.json'), 'utf8'));
  const parsed = parseFixBundle(raw);
  if (!parsed.ok) throw new Error('fix bundle written to disk must parse back');
  return parsed.bundle;
};

const stageRunVerify = async (
  repo: TempGitRepo,
  outDir: string,
  caseFile: CaseFile,
  fixBundle: FixBundle,
  runner: CommandRunner,
): Promise<VerifyBundle> => {
  await runVerifyStage(
    {
      caseFile,
      fixBundle,
      repoPath: repo.repoPath,
      env: buildZeroSecretEnv(process.env),
      timeoutMs: 15_000,
      config: defaultConfig(),
      bundlePath: join(outDir, 'verify-bundle.json'),
    },
    { runner, files: createFileWriter() },
  );
  const raw: unknown = JSON.parse(await readFile(join(outDir, 'verify-bundle.json'), 'utf8'));
  const parsed = parseVerifyBundle(raw);
  if (!parsed.ok) throw new Error('verify bundle written to disk must parse back');
  return parsed.bundle;
};

const stageRunPublish = (
  repo: TempGitRepo,
  caseFile: CaseFile,
  fixBundle: FixBundle,
  verifyBundle: VerifyBundle,
  github: GitHubClient,
  runner: CommandRunner,
): Promise<PublishStageResult> =>
  runPublishStage(
    {
      caseFile,
      fixBundle,
      verifyBundle,
      config: defaultConfig(),
      repoPath: repo.repoPath,
      base: 'main',
      verificationRunLinks: PIPELINE_RUN_LINKS,
      env: buildZeroSecretEnv(process.env),
      timeoutMs: 10_000,
    },
    { github, runner, files: createFileWriter() },
  );

const freshCheckout = async (repo: TempGitRepo): Promise<void> => {
  const git = createCommandRunner();
  const env = buildZeroSecretEnv(process.env);
  const gitRun = async (args: string[]): Promise<void> => {
    await git.run({ command: 'git', args, cwd: repo.repoPath, env, timeoutMs: 10_000 });
  };
  await gitRun(['checkout', '--force', repo.bugCommit]);
  await gitRun(['clean', '-fd']);
};

export const createPipelineHarness = async (): Promise<PipelineHarness> => {
  const repo = await createTempGitRepo();
  const outDir = await mkdtemp(join(tmpdir(), 'amends-bundles-'));
  return {
    repo,
    outDir,
    runFix: (scenario, caseFile) => stageRunFix(repo, outDir, scenario, caseFile),
    runVerify: (caseFile, fixBundle, runner) =>
      stageRunVerify(repo, outDir, caseFile, fixBundle, runner),
    runPublish: (caseFile, fixBundle, verifyBundle, github, runner = createCommandRunner()) =>
      stageRunPublish(repo, caseFile, fixBundle, verifyBundle, github, runner),
    resetToFreshCheckout: () => freshCheckout(repo),
    cleanup: async () => {
      await repo.cleanup();
      await rm(outDir, { recursive: true, force: true });
    },
  };
};
