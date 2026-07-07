import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createRecordingGitHub } from '../../tests/helpers/github-fake.js';
import { stageScenarioAdapter } from '../../tests/helpers/scenario-adapter.js';
import { createTempGitRepo, type TempGitRepo } from '../../tests/helpers/temp-git.js';
import { parseCaseFile } from '../case-file/parse.js';
import type { CaseFile } from '../case-file/types.js';
import { loadConfig } from '../config/load-config.js';
import type { AmendsConfig } from '../config/types.js';
import { CANDIDATE_LABEL } from '../pr/open-pr.js';
import type { CommandRequest, CommandRunner } from '../utils/exec.js';
import { createCommandRunner } from '../utils/exec.js';
import { createFileReader, createFileWriter } from '../utils/fs.js';
import { buildZeroSecretEnv } from '../verification/counterfactual.js';
import { parseFixBundle, parseVerifyBundle, type FixBundle, type VerifyBundle } from './bundle.js';
import { runFixStage } from './fix.js';
import { runPublishStage } from './publish.js';
import { runVerifyStage } from './verify.js';

const FIXTURES_DIR = resolve(import.meta.dirname, '../../../schema/examples');
const TEMPLATE_PATH = resolve(import.meta.dirname, '../../prompts/fix-pass.md');
const INTEGRATION_TIMEOUT = 30_000;

const RUN_LINKS = {
  originalRun: 'https://github.example/example-org/shop-api/actions/runs/9001',
  patchedRun: 'https://github.example/example-org/shop-api/actions/runs/9002',
};

const loadFixtureCaseFile = async (): Promise<CaseFile> => {
  const raw: unknown = JSON.parse(
    await readFile(join(FIXTURES_DIR, 'node-api-500.json'), 'utf8'),
  );
  const parsed = parseCaseFile(raw);
  if (!parsed.ok) throw new Error('fixture node-api-500.json must parse');
  return parsed.caseFile;
};

const defaultConfig = (): AmendsConfig => {
  const result = loadConfig(undefined);
  if (!result.ok) throw new Error('defaults must load');
  return result.config;
};

const recordingRunner = (): { runner: CommandRunner; calls: CommandRequest[] } => {
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

describe('fix -> verify -> publish pipeline (integration, in-process, no network)', () => {
  let repo: TempGitRepo;
  let outDir: string;

  beforeEach(async () => {
    repo = await createTempGitRepo();
    outDir = await mkdtemp(join(tmpdir(), 'amends-bundles-'));
  });

  afterEach(async () => {
    await repo.cleanup();
    await rm(outDir, { recursive: true, force: true });
  });

  const runFixOverScenario = async (
    scenario: Parameters<typeof stageScenarioAdapter>[1],
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
    expect(fixResult.kind).toBe('fix_complete');
    const raw: unknown = JSON.parse(await readFile(join(outDir, 'fix-bundle.json'), 'utf8'));
    const parsed = parseFixBundle(raw);
    if (!parsed.ok) throw new Error('fix bundle written to disk must parse back');
    return parsed.bundle;
  };

  const runVerifyOverBundle = async (
    fixBundle: FixBundle,
    runner: CommandRunner,
  ): Promise<VerifyBundle> => {
    await runVerifyStage(
      {
        fixBundle,
        repoPath: repo.repoPath,
        originalRevision: repo.bugCommit,
        testCommand: repo.testCommand,
        runnerName: 'node',
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

  const resetToFreshCheckout = async (): Promise<void> => {
    const git = createCommandRunner();
    const env = buildZeroSecretEnv(process.env);
    await git.run({
      command: 'git',
      args: ['checkout', '--force', repo.bugCommit],
      cwd: repo.repoPath,
      env,
      timeoutMs: 10_000,
    });
    await git.run({
      command: 'git',
      args: ['clean', '-fd'],
      cwd: repo.repoPath,
      env,
      timeoutMs: 10_000,
    });
  };

  it(
    'happy-tier1 yields exactly one openPullRequest call passing the US-009 body checklist with the candidate label',
    { timeout: INTEGRATION_TIMEOUT },
    async () => {
      const caseFile = await loadFixtureCaseFile();
      const fixBundle = await runFixOverScenario('happy-tier1', caseFile);

      expect(fixBundle.fixDiff).toContain('src/total.js');
      expect(Object.keys(fixBundle.artifactFiles)).toEqual([repo.artifactPath]);

      const verifyBundle = await runVerifyOverBundle(fixBundle, createCommandRunner());
      expect(verifyBundle.verdict.kind).toBe('counterfactual');

      await resetToFreshCheckout();
      const github = createRecordingGitHub();
      const publishResult = await runPublishStage(
        {
          caseFile,
          fixBundle,
          verifyBundle,
          config: defaultConfig(),
          repoPath: repo.repoPath,
          base: 'main',
          verificationRunLinks: RUN_LINKS,
          env: buildZeroSecretEnv(process.env),
          timeoutMs: 10_000,
        },
        { github, runner: createCommandRunner(), files: createFileWriter() },
      );

      expect(publishResult.kind).toBe('published');
      expect(github.pullRequests).toHaveLength(1);
      expect(github.branchPushes).toHaveLength(1);
      expect(github.branchPushes[0]?.branch).toBe('amends/fix-happy-tier1');

      const body = github.pullRequests[0]?.body ?? '';
      expect(body).toContain('## Case-file summary');
      expect(body).toContain(caseFile.work_item.id);
      expect(body).toContain(repo.artifactPath);
      expect(body).toContain(RUN_LINKS.originalRun);
      expect(body).toContain(RUN_LINKS.patchedRun);
      expect(body).toContain('Tier 1');
      expect(body).toContain('fixture_only_data_path');
      expect(body).toContain('fake-adapter');
      expect(body).toContain('fake-model');
      expect(body).toContain('## Autonomy downgrade');
      expect(body).not.toMatch(/proven/i);

      const prNumber = github.pullRequests.length > 0 ? 101 : 0;
      expect(github.labels).toContainEqual({ issueNumber: prNumber, label: CANDIDATE_LABEL });

      const patchedFile = await readFile(join(repo.repoPath, 'src/total.js'), 'utf8');
      expect(patchedFile).toContain('item.quantity');
    },
  );

  it(
    'touches-workflow refuses before any verification run and opens nothing',
    { timeout: INTEGRATION_TIMEOUT },
    async () => {
      const caseFile = await loadFixtureCaseFile();
      const fixBundle = await runFixOverScenario('touches-workflow', caseFile);

      const verify = recordingRunner();
      const verifyBundle = await runVerifyOverBundle(fixBundle, verify.runner);
      expect(verify.calls).toHaveLength(0);
      expect(verifyBundle.verdict.kind).toBe('guardrail_violation');
      if (verifyBundle.verdict.kind === 'guardrail_violation') {
        expect(verifyBundle.verdict.violation.kind).toBe('hard_blocked');
        expect(verifyBundle.verdict.violation.paths).toContain('.github/workflows/release.yml');
      }

      const github = createRecordingGitHub();
      const publish = recordingRunner();
      const publishResult = await runPublishStage(
        {
          caseFile,
          fixBundle,
          verifyBundle,
          config: defaultConfig(),
          repoPath: repo.repoPath,
          base: 'main',
          verificationRunLinks: RUN_LINKS,
          env: buildZeroSecretEnv(process.env),
          timeoutMs: 10_000,
        },
        { github, runner: publish.runner, files: createFileWriter() },
      );

      expect(publishResult.kind).toBe('not_publishable');
      expect(publish.calls).toHaveLength(0);
      expect(github.branchPushes).toHaveLength(0);
      expect(github.pullRequests).toHaveLength(0);
      expect(github.labels).toHaveLength(0);
      expect(github.comments).toHaveLength(0);
    },
  );
});
