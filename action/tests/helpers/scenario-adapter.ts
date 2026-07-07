import { writeFile } from 'node:fs/promises';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { CommandRunner } from '../../src/utils/exec.js';
import { emitFakeAdapter } from './fake-adapter.js';
import type { FakeAdapterScenario } from './fake-adapter.js';
import { COUNTERFACTUAL_NODE_ARTIFACT } from './temp-git.js';
import type { TempGitRepo } from './temp-git.js';

/**
 * Bridges the scripted fake-adapter scenarios (US-006) onto a temp-git repo
 * (US-008): writes the "adapter output" — fix patch and artifact files — into
 * the checkout as a real adapter would, and returns a CommandRunner whose
 * stdout is the matching conformant result JSON. Runnable scenarios use the
 * repo's own applyable fix diff and node-runnable artifacts; path-refusal
 * scenarios keep the fake adapter's scripted diff (refused before any run).
 */

const FIX_DIFF_PATH = 'amends-out/fix.patch';

const ALWAYS_PASSING_NODE_ARTIFACT = [
  "import assert from 'node:assert/strict';",
  '',
  'assert.equal(1, 1);',
  '',
].join('\n');

const ALWAYS_FAILING_NODE_ARTIFACT = [
  "import assert from 'node:assert/strict';",
  '',
  'assert.equal(1, 2);',
  '',
].join('\n');

const RUNNABLE_SCENARIOS: readonly FakeAdapterScenario[] = [
  'happy-tier1',
  'non-counterfactual',
  'fix-insufficient',
  'no-artifact',
];

const artifactFilesFor = (
  repo: TempGitRepo,
  scenario: FakeAdapterScenario,
): Record<string, string> => {
  switch (scenario) {
    case 'non-counterfactual':
      return { [repo.artifactPath]: ALWAYS_PASSING_NODE_ARTIFACT };
    case 'fix-insufficient':
      return { [repo.artifactPath]: ALWAYS_FAILING_NODE_ARTIFACT };
    case 'no-artifact':
      return {};
    default:
      return { [repo.artifactPath]: COUNTERFACTUAL_NODE_ARTIFACT };
  }
};

export interface StagedScenario {
  adapterRunner: CommandRunner;
  branchRef: string;
  fixDiff: string;
  artifactFiles: Record<string, string>;
}

export const stageScenarioAdapter = async (
  repo: TempGitRepo,
  scenario: FakeAdapterScenario,
): Promise<StagedScenario> => {
  const emit = emitFakeAdapter(scenario);
  const fixDiff = RUNNABLE_SCENARIOS.includes(scenario) ? repo.fixDiff : emit.fixDiff;
  const artifactFiles = artifactFilesFor(repo, scenario);

  const writeInRepo = async (path: string, content: string): Promise<void> => {
    const absolute = join(repo.repoPath, path);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, content, 'utf8');
  };
  await writeInRepo(FIX_DIFF_PATH, fixDiff);
  for (const [path, content] of Object.entries(artifactFiles)) {
    await writeInRepo(path, content);
  }

  const branchRef = `amends/fix-${scenario}`;
  const resultJson = JSON.stringify({
    branch_ref: branchRef,
    fix_diff_path: FIX_DIFF_PATH,
    artifact_paths: Object.keys(artifactFiles),
    usage: emit.usage,
  });
  return {
    adapterRunner: {
      run: () => Promise.resolve({ kind: 'completed', exitCode: 0, stdout: resultJson, stderr: '' }),
    },
    branchRef,
    fixDiff,
    artifactFiles,
  };
};
