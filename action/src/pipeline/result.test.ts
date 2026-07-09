import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { FakeAdapterScenario } from '../../tests/helpers/fake-adapter.js';
import { createRecordingGitHub } from '../../tests/helpers/github-fake.js';
import type { RecordingGitHub } from '../../tests/helpers/github-fake.js';
import {
  bindCaseFileToRepo,
  createPipelineHarness,
  loadFixtureCaseFile,
  nonEnumerationCalls,
  recordingRealRunner,
  recordingRunner,
} from '../../tests/helpers/pipeline-harness.js';
import type { PipelineHarness } from '../../tests/helpers/pipeline-harness.js';
import type { CaseFile } from '../case-file/types.js';
import { createCommandRunner } from '../utils/exec.js';
import type { CommandRequest, CommandRunner } from '../utils/exec.js';
import type { VerificationObservation } from '../verification/observation.js';
import type { PublishStageResult } from './publish.js';
import { summarizePipelineResult } from './result.js';
import type { PipelineResult, PipelineVerdict } from './result.js';

const INTEGRATION_TIMEOUT = 30_000;

const expectZeroGitHubWrites = (github: RecordingGitHub): void => {
  expect(github.branchPushes).toHaveLength(0);
  expect(github.pullRequests).toHaveLength(0);
  expect(github.labels).toHaveLength(0);
  expect(github.comments).toHaveLength(0);
};

interface DriveOutcome {
  verdict: PipelineVerdict;
  result: PublishStageResult;
  github: RecordingGitHub;
  publishCalls: CommandRequest[];
}

describe('gate-refusal paths (integration, in-process, no network)', () => {
  let harness: PipelineHarness;

  beforeEach(async () => {
    harness = await createPipelineHarness();
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  const drive = async (
    caseFile: CaseFile,
    scenario: FakeAdapterScenario,
    verifyRunner: CommandRunner,
  ): Promise<DriveOutcome> => {
    const fixBundle = await harness.runFix(scenario, caseFile);
    const verifyBundle = await harness.runVerify(caseFile, fixBundle, verifyRunner);
    const github = createRecordingGitHub();
    const publish = recordingRunner();
    const result = await harness.runPublish(caseFile, fixBundle, verifyBundle, github, publish.runner);
    return { verdict: verifyBundle.verdict, result, github, publishCalls: publish.calls };
  };

  const runnableCaseFile = async (): Promise<CaseFile> =>
    bindCaseFileToRepo(await loadFixtureCaseFile('node-api-500.json'), harness.repo);

  it(
    'thin case file + no-artifact exits evidence_gate_unmet listing what was missing, zero GitHub writes',
    { timeout: INTEGRATION_TIMEOUT },
    async () => {
      const caseFile = await loadFixtureCaseFile('thin-casefile-needs-instrumentation.json');
      const verify = recordingRunner();
      const { verdict, result, github, publishCalls } = await drive(caseFile, 'no-artifact', verify.runner);

      expect(verify.calls).toHaveLength(0);
      expect(verdict.kind).toBe('evidence_gate_unmet');
      expect(result.kind).toBe('evidence_gate_unmet');
      if (result.kind === 'evidence_gate_unmet') {
        expect(result.missing).toEqual(['counterfactual_artifact', 'validation.test_command']);
      }
      expect(publishCalls).toHaveLength(0);
      expectZeroGitHubWrites(github);
    },
  );

  it(
    'non-counterfactual exits not_counterfactual, zero GitHub writes',
    { timeout: INTEGRATION_TIMEOUT },
    async () => {
      const caseFile = await runnableCaseFile();
      const { result, github } = await drive(caseFile, 'non-counterfactual', createCommandRunner());

      expect(result.kind).toBe('not_counterfactual');
      if (result.kind === 'not_counterfactual') {
        expect(result.originalRun.passed).toBe(true);
      }
      expectZeroGitHubWrites(github);
    },
  );

  it(
    'fix-insufficient exits fix_insufficient with machine-readable reasons, zero GitHub writes',
    { timeout: INTEGRATION_TIMEOUT },
    async () => {
      const caseFile = await runnableCaseFile();
      const { result, github } = await drive(caseFile, 'fix-insufficient', createCommandRunner());

      expect(result.kind).toBe('fix_insufficient');
      if (result.kind === 'fix_insufficient') {
        expect(result.reasons).toContain('artifact_failed_on_patched');
        expect(result.reasons).toContain('failure_signature_unchanged_from_original');
      }
      expectZeroGitHubWrites(github);
    },
  );

  it(
    'touches-workflow exits guardrail_violation (hard_blocked) before any verification run, zero GitHub writes',
    { timeout: INTEGRATION_TIMEOUT },
    async () => {
      const caseFile = await runnableCaseFile();
      const verify = recordingRealRunner();
      const { result, github, publishCalls } = await drive(caseFile, 'touches-workflow', verify.runner);

      expect(nonEnumerationCalls(verify.calls)).toHaveLength(0);
      expect(result.kind).toBe('guardrail_violation');
      if (result.kind === 'guardrail_violation' && result.violation.kind === 'hard_blocked') {
        expect(result.violation.paths).toContain('.github/workflows/release.yml');
      } else {
        throw new Error('expected a hard_blocked guardrail violation');
      }
      expect(publishCalls).toHaveLength(0);
      expectZeroGitHubWrites(github);
    },
  );

  it(
    'touches-test-config exits guardrail_violation (invariance) before any verification run, zero GitHub writes',
    { timeout: INTEGRATION_TIMEOUT },
    async () => {
      const caseFile = await runnableCaseFile();
      const verify = recordingRealRunner();
      const { result, github } = await drive(caseFile, 'touches-test-config', verify.runner);

      expect(nonEnumerationCalls(verify.calls)).toHaveLength(0);
      expect(result.kind).toBe('guardrail_violation');
      if (result.kind === 'guardrail_violation' && result.violation.kind === 'invariance') {
        expect(result.violation.paths).toContain('vitest.config.ts');
      } else {
        throw new Error('expected an invariance guardrail violation');
      }
      expectZeroGitHubWrites(github);
    },
  );

  it(
    'too-many-files exits cap_exceeded before any verification run, zero GitHub writes',
    { timeout: INTEGRATION_TIMEOUT },
    async () => {
      const caseFile = await runnableCaseFile();
      const verify = recordingRealRunner();
      const { result, github } = await drive(caseFile, 'too-many-files', verify.runner);

      expect(nonEnumerationCalls(verify.calls)).toHaveLength(0);
      expect(result.kind).toBe('cap_exceeded');
      if (result.kind === 'cap_exceeded') {
        expect(result.fileCount).toBeGreaterThan(result.limit);
        expect(result.limit).toBe(10);
      }
      expectZeroGitHubWrites(github);
    },
  );

  it(
    'unresolved release exits release_unresolved before any verification run, zero GitHub writes',
    { timeout: INTEGRATION_TIMEOUT },
    async () => {
      // The fix bundle is produced under a resolved case file; the unresolved
      // one reaches verify + publish, which must both refuse structurally.
      const resolved = await runnableCaseFile();
      const fixBundle = await harness.runFix('happy-tier1', resolved);
      const caseFile = await loadFixtureCaseFile('node-api-500-unresolved.json');
      const verify = recordingRunner();
      const verifyBundle = await harness.runVerify(caseFile, fixBundle, verify.runner);
      const github = createRecordingGitHub();
      const publish = recordingRunner();
      const result = await harness.runPublish(caseFile, fixBundle, verifyBundle, github, publish.runner);

      expect(verify.calls).toHaveLength(0);
      expect(verifyBundle.verdict.kind).toBe('release_unresolved');
      expect(result.kind).toBe('release_unresolved');
      if (result.kind === 'release_unresolved') {
        expect(result.declared).toBe(caseFile.release.declared);
      }
      expect(publish.calls).toHaveLength(0);
      expectZeroGitHubWrites(github);
    },
  );
});

describe('summarizePipelineResult (exhaustive over the result union)', () => {
  const observation: VerificationObservation = {
    runner: 'node',
    artifactPaths: ['artifact.test.mjs'],
    serverProcessSpawned: false,
    httpExercised: false,
    browserExercised: false,
    dataPath: 'fixture-only',
    originalRun: { passed: false, failureSignature: 'exit 1: assertion' },
    patchedRun: { passed: false, failureSignature: 'exit 1: assertion' },
  };

  const results: PipelineResult[] = [
    {
      kind: 'published',
      outcome: {
        kind: 'pr_opened',
        pr: { number: 101, url: 'https://github.example/pr/101' },
        labels: [],
        autoMergeEligible: false,
      },
    },
    { kind: 'evidence_gate_unmet', missing: ['counterfactual_artifact'] },
    { kind: 'not_counterfactual', originalRun: { passed: true } },
    { kind: 'fix_insufficient', reasons: ['artifact_failed_on_patched'], observation },
    { kind: 'guardrail_violation', violation: { kind: 'hard_blocked', paths: ['amends.yml'] } },
    { kind: 'guardrail_violation', violation: { kind: 'invariance', paths: ['tsconfig.json'] } },
    { kind: 'guardrail_violation', violation: { kind: 'unenumerable_diff', reason: 'git apply --numstat failed' } },
    { kind: 'cap_exceeded', fileCount: 11, limit: 10 },
    { kind: 'release_unresolved', declared: 'api@2.1.0' },
  ];

  it.each(results.map((result) => ({ kind: result.kind, result })))(
    'renders a non-empty summary for $kind without the forbidden word',
    ({ result }) => {
      const summary = summarizePipelineResult(result);
      expect(summary.length).toBeGreaterThan(0);
      expect(summary).not.toMatch(/proven/i);
    },
  );

  it('throws on a result arm outside the union (never-check is live at runtime too)', () => {
    expect(() => summarizePipelineResult({ kind: 'mystery' } as never)).toThrow(/unhandled pipeline result/);
  });
});
