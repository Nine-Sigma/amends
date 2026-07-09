import { readFile } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  bindCaseFileToRepo,
  loadFixtureCaseFile,
} from '../../tests/helpers/pipeline-harness.js';
import { stageScenarioAdapter } from '../../tests/helpers/scenario-adapter.js';
import { createTempGitRepo } from '../../tests/helpers/temp-git.js';
import type { TempGitRepo } from '../../tests/helpers/temp-git.js';
import type { CommandRequest, CommandRunner } from '../utils/exec.js';
import { createFileReader, createFileWriter } from '../utils/fs.js';
import { runFixStage } from './fix.js';
import type { FixStageDeps, FixStageRequest } from './fix.js';

const INTEGRATION_TIMEOUT = 30_000;

const TEMPLATE_PATH = resolve(import.meta.dirname, '../../prompts/fix-pass.md');

const recordingWrap = (
  inner: CommandRunner,
): { runner: CommandRunner; calls: string[] } => {
  const calls: string[] = [];
  return {
    calls,
    runner: {
      run: (request: CommandRequest) => {
        calls.push([request.command, ...request.args].join(' '));
        return inner.run(request);
      },
    },
  };
};

describe('runFixStage', () => {
  let repo: TempGitRepo | undefined;

  afterEach(async () => {
    await repo?.cleanup();
    repo = undefined;
  });

  const requestFor = async (
    activeRepo: TempGitRepo,
    outDir: string,
  ): Promise<FixStageRequest> => ({
    caseFile: bindCaseFileToRepo(await loadFixtureCaseFile('node-api-500.json'), activeRepo),
    invocation: {
      command: 'fake-adapter',
      args: [],
      input: {
        checkout_path: activeRepo.repoPath,
        case_file_path: 'unused-here.json',
        model_config: { model: 'fake-model' },
      },
      env: { PATH: process.env['PATH'] ?? '' },
      timeoutMs: INTEGRATION_TIMEOUT,
    },
    promptTemplate: await readFile(TEMPLATE_PATH, 'utf8'),
    promptPath: join(outDir, 'prompt.md'),
    bundlePath: join(outDir, 'fix-bundle.json'),
  });

  it('refuses an unresolved release before anything runs or is written', async () => {
    const calls: string[] = [];
    const writes: string[] = [];
    const deps: FixStageDeps = {
      runner: {
        run: (request) => {
          calls.push(request.command);
          return Promise.resolve({ kind: 'completed', exitCode: 0, stdout: '', stderr: '' });
        },
      },
      files: {
        write: (absolutePath) => {
          writes.push(absolutePath);
          return Promise.resolve();
        },
      },
      reader: createFileReader(),
    };
    const caseFile = await loadFixtureCaseFile('node-api-500-unresolved.json');

    const result = await runFixStage(
      {
        caseFile,
        invocation: {
          command: 'fake-adapter',
          args: [],
          input: { checkout_path: '/unused', case_file_path: 'x.json', model_config: { model: 'm' } },
          env: {},
          timeoutMs: 1_000,
        },
        promptTemplate: 'template',
        promptPath: '/unused/prompt.md',
        bundlePath: '/unused/fix-bundle.json',
      },
      deps,
    );

    expect(result).toEqual({ kind: 'release_unresolved', declared: caseFile.release.declared });
    expect(calls).toEqual([]);
    expect(writes).toEqual([]);
  });

  it(
    'checks out the incident revision before the adapter runs, so the diff is against the verified base',
    async () => {
      repo = await createTempGitRepo();
      const outDir = await mkdtemp(join(tmpdir(), 'amends-fix-stage-'));
      const staged = await stageScenarioAdapter(repo, 'happy-tier1');
      const recorded = recordingWrap(staged.adapterRunner);
      const request = await requestFor(repo, outDir);

      const result = await runFixStage(request, {
        runner: recorded.runner,
        files: createFileWriter(),
        reader: createFileReader(),
      });

      expect(result.kind).toBe('fix_complete');
      expect(recorded.calls[0]).toBe(`git checkout --force ${repo.bugCommit}`);
      expect(recorded.calls[1]).toBe('git clean -fd');
      expect(recorded.calls[2]).toBe('fake-adapter');
    },
    INTEGRATION_TIMEOUT,
  );
});
