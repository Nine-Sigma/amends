import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createRecordingGitHub } from '../../tests/helpers/github-fake.js';
import {
  bindCaseFileToRepo,
  createPipelineHarness,
  defaultConfig,
  loadFixtureCaseFile,
  PIPELINE_RUN_LINKS,
} from '../../tests/helpers/pipeline-harness.js';
import type { PipelineHarness } from '../../tests/helpers/pipeline-harness.js';
import { createCommandRunner } from '../utils/exec.js';
import { createFileWriter } from '../utils/fs.js';
import type { FixBundle } from './bundle.js';
import { runPublishStage } from './publish.js';

const execFileAsync = promisify(execFile);

const INTEGRATION_TIMEOUT = 60_000;

describe('runPublishStage', () => {
  let harness: PipelineHarness;

  beforeEach(async () => {
    harness = await createPipelineHarness();
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  it('refuses an unresolved release with no git or GitHub writes', async () => {
    const caseFile = await loadFixtureCaseFile('node-api-500-unresolved.json');
    const github = createRecordingGitHub();
    const calls: string[] = [];
    const fixBundle: FixBundle = {
      fixDiff: '',
      artifactFiles: { 'artifact.test.mjs': '// artifact' },
      adapterResult: {
        branch_ref: 'amends/fix-x',
        fix_diff_path: 'amends-out/fix.patch',
        artifact_paths: ['artifact.test.mjs'],
        usage: { input_tokens: null, output_tokens: null, estimated_usd: null, usage_source: 'unavailable' },
        exit_code: 0,
      },
      agentIdentity: { agent: 'fake-adapter', model: 'fake-model' },
    };

    const result = await runPublishStage(
      {
        caseFile,
        fixBundle,
        verifyBundle: {
          verdict: {
            kind: 'counterfactual',
            observation: {
              runner: 'node',
              artifactPaths: ['artifact.test.mjs'],
              serverProcessSpawned: false,
              httpExercised: false,
              browserExercised: false,
              dataPath: 'fixture-only',
              originalRun: { passed: false, failureSignature: 'exit 1: boom' },
              patchedRun: { passed: true },
            },
          },
        },
        config: defaultConfig(),
        repoPath: harness.repo.repoPath,
        base: 'main',
        verificationRunLinks: PIPELINE_RUN_LINKS,
        env: {},
        timeoutMs: 1_000,
      },
      {
        github,
        runner: {
          run: (request) => {
            calls.push(request.command);
            return Promise.resolve({ kind: 'completed', exitCode: 0, stdout: '', stderr: '' });
          },
        },
        files: createFileWriter(),
      },
    );

    expect(result.kind).toBe('release_unresolved');
    expect(calls).toEqual([]);
    expect(github.branchPushes).toEqual([]);
    expect(github.pullRequests).toEqual([]);
  });

  it(
    'publishes from release.revision even after the branch HEAD has drifted with a conflicting change',
    async () => {
      const caseFile = bindCaseFileToRepo(
        await loadFixtureCaseFile('node-api-500.json'),
        harness.repo,
      );
      const fixBundle = await harness.runFix('happy-tier1', caseFile);
      const verifyBundle = await harness.runVerify(caseFile, fixBundle, createCommandRunner());
      expect(verifyBundle.verdict.kind).toBe('counterfactual');

      const git = (...args: string[]) =>
        execFileAsync('git', args, { cwd: harness.repo.repoPath });
      await git('checkout', '--force', 'main');
      await writeFile(
        join(harness.repo.repoPath, 'src/total.js'),
        'export const total = () => { throw new Error("conflicting drift"); };\n',
      );
      await git('add', '-A');
      await git('commit', '-m', 'drift past the incident revision');

      const github = createRecordingGitHub();
      const result = await harness.runPublish(caseFile, fixBundle, verifyBundle, github);

      expect(result.kind).toBe('published');
      expect(github.branchPushes).toHaveLength(1);
      expect(github.branchPushes[0]?.paths).toContain('src/total.js');
      expect(github.branchPushes[0]?.paths).not.toContain('amends-out/fix.patch');
    },
    INTEGRATION_TIMEOUT,
  );
});
