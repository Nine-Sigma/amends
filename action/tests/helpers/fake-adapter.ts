import type { CommandRunner } from '../../src/utils/exec.js';
import type { UsageBlock } from '../../src/adapter/types.js';

/**
 * Scripted test-only adapter: given a scenario name, emits a known fix diff,
 * known counterfactual artifact files, and conformant result JSON. Lives under
 * action/tests/ (excluded from the package build); action/agents/ is reserved
 * for real shipped adapters (§3.1).
 */
export type FakeAdapterScenario =
  | 'happy-tier1'
  | 'touches-workflow'
  | 'touches-test-config'
  | 'non-counterfactual'
  | 'fix-insufficient'
  | 'no-artifact'
  | 'too-many-files';

export const FAKE_ADAPTER_SCENARIOS: readonly FakeAdapterScenario[] = [
  'happy-tier1',
  'touches-workflow',
  'touches-test-config',
  'non-counterfactual',
  'fix-insufficient',
  'no-artifact',
  'too-many-files',
];

export interface FakeAdapterEmit {
  /** The result JSON the adapter prints to stdout, conformant per §3.4. */
  resultJson: string;
  /** Unified fix diff, separable from the artifacts. */
  fixDiff: string;
  /** Repo-relative paths the fix diff touches. */
  fixDiffPaths: string[];
  /** Counterfactual artifact files: repo-relative path -> content. */
  artifactFiles: Record<string, string>;
  usage: UsageBlock;
}

const ARTIFACT_PATH = 'src/checkout/total.counterfactual.test.ts';

const COUNTERFACTUAL_ARTIFACT = [
  "import { describe, expect, it } from 'vitest';",
  "import { total } from './total.js';",
  '',
  "describe('total (counterfactual)', () => {",
  "  it('multiplies price by quantity', () => {",
  '    expect(total([{ price: 5, quantity: 3 }])).toBe(15);',
  '  });',
  '});',
  '',
].join('\n');

const ALWAYS_PASSING_ARTIFACT = [
  "import { expect, it } from 'vitest';",
  '',
  "it('passes on any revision (not a counterfactual)', () => {",
  '  expect(true).toBe(true);',
  '});',
  '',
].join('\n');

const ALWAYS_FAILING_ARTIFACT = [
  "import { expect, it } from 'vitest';",
  '',
  "it('fails on any revision (fix is insufficient)', () => {",
  '  expect(true).toBe(false);',
  '});',
  '',
].join('\n');

const HAPPY_FIX_PATHS = ['src/checkout/total.ts'];

const TOO_MANY_FIX_PATHS = Array.from({ length: 11 }, (_, i) => `src/checkout/file-${i}.ts`);

const diffFor = (paths: string[]): string =>
  paths
    .map((path) =>
      [
        `diff --git a/${path} b/${path}`,
        `--- a/${path}`,
        `+++ b/${path}`,
        '@@ -1 +1 @@',
        '-// buggy',
        '+// fixed',
        '',
      ].join('\n'),
    )
    .join('');

const REPORTED_USAGE: UsageBlock = {
  input_tokens: 41_250,
  output_tokens: 3_180,
  estimated_usd: 0.42,
  usage_source: 'reported',
};

const ESTIMATED_USAGE: UsageBlock = {
  input_tokens: null,
  output_tokens: null,
  estimated_usd: 0.5,
  usage_source: 'estimated',
};

const UNAVAILABLE_USAGE: UsageBlock = {
  input_tokens: null,
  output_tokens: null,
  estimated_usd: null,
  usage_source: 'unavailable',
};

interface ScenarioScript {
  fixDiffPaths: string[];
  artifactFiles: Record<string, string>;
  usage: UsageBlock;
}

const SCENARIOS: Record<FakeAdapterScenario, ScenarioScript> = {
  'happy-tier1': {
    fixDiffPaths: HAPPY_FIX_PATHS,
    artifactFiles: { [ARTIFACT_PATH]: COUNTERFACTUAL_ARTIFACT },
    usage: REPORTED_USAGE,
  },
  'touches-workflow': {
    fixDiffPaths: [...HAPPY_FIX_PATHS, '.github/workflows/release.yml'],
    artifactFiles: { [ARTIFACT_PATH]: COUNTERFACTUAL_ARTIFACT },
    usage: ESTIMATED_USAGE,
  },
  'touches-test-config': {
    fixDiffPaths: [...HAPPY_FIX_PATHS, 'vitest.config.ts'],
    artifactFiles: { [ARTIFACT_PATH]: COUNTERFACTUAL_ARTIFACT },
    usage: ESTIMATED_USAGE,
  },
  'non-counterfactual': {
    fixDiffPaths: HAPPY_FIX_PATHS,
    artifactFiles: { [ARTIFACT_PATH]: ALWAYS_PASSING_ARTIFACT },
    usage: ESTIMATED_USAGE,
  },
  'fix-insufficient': {
    fixDiffPaths: HAPPY_FIX_PATHS,
    artifactFiles: { [ARTIFACT_PATH]: ALWAYS_FAILING_ARTIFACT },
    usage: ESTIMATED_USAGE,
  },
  'no-artifact': {
    fixDiffPaths: HAPPY_FIX_PATHS,
    artifactFiles: {},
    usage: UNAVAILABLE_USAGE,
  },
  'too-many-files': {
    fixDiffPaths: TOO_MANY_FIX_PATHS,
    artifactFiles: { [ARTIFACT_PATH]: COUNTERFACTUAL_ARTIFACT },
    usage: ESTIMATED_USAGE,
  },
};

export const emitFakeAdapter = (scenario: FakeAdapterScenario): FakeAdapterEmit => {
  const script = SCENARIOS[scenario];
  return {
    resultJson: JSON.stringify({
      branch_ref: `amends/fix-${scenario}`,
      fix_diff_path: 'amends-out/fix.patch',
      artifact_paths: Object.keys(script.artifactFiles),
      usage: script.usage,
    }),
    fixDiff: diffFor(script.fixDiffPaths),
    fixDiffPaths: script.fixDiffPaths,
    artifactFiles: script.artifactFiles,
    usage: script.usage,
  };
};

/** A CommandRunner that "spawns" the fake adapter: exits 0 with the scenario's result JSON on stdout. */
export const fakeAdapterRunner = (scenario: FakeAdapterScenario): CommandRunner => ({
  run: () =>
    Promise.resolve({
      kind: 'completed',
      exitCode: 0,
      stdout: emitFakeAdapter(scenario).resultJson,
      stderr: '',
    }),
});
