import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { emitFakeAdapter } from '../../tests/helpers/fake-adapter.js';
import { COUNTERFACTUAL_NODE_ARTIFACT, createTempGitRepo } from '../../tests/helpers/temp-git.js';
import type { TempGitRepo } from '../../tests/helpers/temp-git.js';
import { loadConfig } from '../config/load-config.js';
import type { AmendsConfig } from '../config/types.js';
import { createCommandRunner } from '../utils/exec.js';
import type { CommandRequest } from '../utils/exec.js';
import { createFileWriter } from '../utils/fs.js';
import {
  buildZeroSecretEnv,
  runCounterfactual,
  ZERO_SECRET_ENV_ALLOWLIST,
} from './counterfactual.js';
import type { CounterfactualDeps, CounterfactualRequest } from './counterfactual.js';

const INTEGRATION_TIMEOUT = 30_000;

const ALWAYS_PASSING_NODE_ARTIFACT = [
  "import assert from 'node:assert/strict';",
  '',
  'assert.ok(true);',
  '',
].join('\n');

const ALWAYS_FAILING_NODE_ARTIFACT = [
  "import assert from 'node:assert/strict';",
  '',
  "assert.ok(false, 'fails on every revision');",
  '',
].join('\n');

const defaultConfig = (): AmendsConfig => {
  const result = loadConfig(undefined);
  if (!result.ok) throw new Error('default config must load');
  return result.config;
};

const realDeps = (): CounterfactualDeps => ({
  runner: createCommandRunner(),
  files: createFileWriter(),
});

/** Real runner/files with recorders, so refusal tests can prove what ran and what was written. */
const spyingDeps = (): CounterfactualDeps & { runs: string[]; writes: string[] } => {
  const runner = createCommandRunner();
  const files = createFileWriter();
  const runs: string[] = [];
  const writes: string[] = [];
  return {
    runs,
    writes,
    runner: {
      run: (request: CommandRequest) => {
        runs.push(`${request.command} ${request.args.join(' ')}`);
        return runner.run(request);
      },
    },
    files: {
      write: (absolutePath: string, content: string) => {
        writes.push(absolutePath);
        return files.write(absolutePath, content);
      },
    },
  };
};

describe('runCounterfactual', () => {
  let repo: TempGitRepo | undefined;

  afterEach(async () => {
    await repo?.cleanup();
    repo = undefined;
  });

  const requestFor = (
    activeRepo: TempGitRepo,
    artifactContent: string,
  ): CounterfactualRequest => ({
    repoPath: activeRepo.repoPath,
    originalRevision: activeRepo.bugCommit,
    fixDiff: activeRepo.fixDiff,
    artifactFiles: { [activeRepo.artifactPath]: artifactContent },
    testCommand: activeRepo.testCommand,
    runnerName: 'node',
    env: buildZeroSecretEnv(process.env),
    timeoutMs: INTEGRATION_TIMEOUT,
    config: defaultConfig(),
  });

  it(
    'yields not_counterfactual when the artifact passes on the original revision, with no PR-eligible observation',
    async () => {
      repo = await createTempGitRepo();

      const verdict = await runCounterfactual(
        requestFor(repo, ALWAYS_PASSING_NODE_ARTIFACT),
        realDeps(),
      );

      expect(verdict.kind).toBe('not_counterfactual');
      expect(verdict).not.toHaveProperty('observation');
    },
    INTEGRATION_TIMEOUT,
  );

  it(
    'yields counterfactual with both run outcomes when the artifact fails on original and passes on patched',
    async () => {
      repo = await createTempGitRepo();

      const verdict = await runCounterfactual(
        requestFor(repo, COUNTERFACTUAL_NODE_ARTIFACT),
        realDeps(),
      );

      expect(verdict.kind).toBe('counterfactual');
      if (verdict.kind !== 'counterfactual') return;
      expect(verdict.observation.runner).toBe('node');
      expect(verdict.observation.artifactPaths).toEqual(['artifact.test.mjs']);
      expect(verdict.observation.originalRun.passed).toBe(false);
      if (verdict.observation.originalRun.passed) return;
      expect(verdict.observation.originalRun.failureSignature).not.toBe('');
      expect(verdict.observation.patchedRun).toEqual({ passed: true });
    },
    INTEGRATION_TIMEOUT,
  );

  it(
    'distinguishes an artifact that always fails: fix_insufficient with an unchanged failure signature',
    async () => {
      repo = await createTempGitRepo();

      const verdict = await runCounterfactual(
        requestFor(repo, ALWAYS_FAILING_NODE_ARTIFACT),
        realDeps(),
      );

      expect(verdict.kind).toBe('fix_insufficient');
      if (verdict.kind !== 'fix_insufficient') return;
      expect(verdict.reasons).toContain('artifact_failed_on_patched');
      expect(verdict.reasons).toContain('failure_signature_unchanged_from_original');
      const { originalRun, patchedRun } = verdict.observation;
      if (originalRun.passed || patchedRun.passed) throw new Error('both runs must fail');
      expect(patchedRun.failureSignature).toBe(originalRun.failureSignature);
    },
    INTEGRATION_TIMEOUT,
  );

  it(
    'yields fix_insufficient with fix_diff_apply_failed when the fix diff does not apply',
    async () => {
      repo = await createTempGitRepo();
      const request = {
        ...requestFor(repo, COUNTERFACTUAL_NODE_ARTIFACT),
        fixDiff: [
          'diff --git a/src/missing.js b/src/missing.js',
          '--- a/src/missing.js',
          '+++ b/src/missing.js',
          '@@ -1 +1 @@',
          '-nope',
          '+still nope',
          '',
        ].join('\n'),
      };

      const verdict = await runCounterfactual(request, realDeps());

      expect(verdict.kind).toBe('fix_insufficient');
      if (verdict.kind !== 'fix_insufficient') return;
      expect(verdict.reasons).toContain('fix_diff_apply_failed');
    },
    INTEGRATION_TIMEOUT,
  );

  describe('guardrails refuse before any test execution or worktree write', () => {
    const guardrailRequest = (activeRepo: TempGitRepo, fixDiff: string): CounterfactualRequest => ({
      ...requestFor(activeRepo, '// artifact'),
      fixDiff,
      artifactFiles: { 'src/checkout/total.counterfactual.test.ts': '// artifact' },
    });

    /** Path enumeration alone may run (`git apply --numstat/--summary`) and write the .git-internal patch scratch. */
    const expectNothingExecuted = (deps: { runs: string[]; writes: string[] }): void => {
      for (const run of deps.runs) {
        expect(run.startsWith('git apply --'), `unexpected command before refusal: ${run}`).toBe(true);
      }
      for (const write of deps.writes) {
        expect(write.includes('/.git/'), `unexpected worktree write before refusal: ${write}`).toBe(true);
      }
    };

    it(
      'a hard-blocked fix diff never executes a test run and never writes into the worktree',
      async () => {
        repo = await createTempGitRepo();
        const deps = spyingDeps();

        const verdict = await runCounterfactual(
          guardrailRequest(repo, emitFakeAdapter('touches-workflow').fixDiff),
          deps,
        );

        expect(verdict.kind).toBe('guardrail_violation');
        if (verdict.kind !== 'guardrail_violation') return;
        if (verdict.violation.kind !== 'hard_blocked') throw new Error('expected hard_blocked');
        expect(verdict.violation.paths).toContain('.github/workflows/release.yml');
        expectNothingExecuted(deps);
      },
      INTEGRATION_TIMEOUT,
    );

    it(
      'a header-less bare diff is judged by the path git apply will write, not by its (absent) header',
      async () => {
        repo = await createTempGitRepo();
        const deps = spyingDeps();
        const bareDiff = [
          '--- a/src/total.js',
          '+++ b/.github/workflows/evil.yml',
          '@@ -1 +1 @@',
          '-export const total = (items) => items.reduce((sum, item) => sum + item.price, 0);',
          '+evil: true',
          '',
        ].join('\n');

        const verdict = await runCounterfactual(guardrailRequest(repo, bareDiff), deps);

        expect(verdict.kind).toBe('guardrail_violation');
        if (verdict.kind !== 'guardrail_violation') return;
        if (verdict.violation.kind !== 'hard_blocked') throw new Error('expected hard_blocked');
        expect(verdict.violation.paths).toContain('.github/workflows/evil.yml');
        expectNothingExecuted(deps);
      },
      INTEGRATION_TIMEOUT,
    );

    it(
      'an unenumerable diff is refused closed, never treated as touching nothing',
      async () => {
        repo = await createTempGitRepo();
        const deps = spyingDeps();

        const verdict = await runCounterfactual(
          guardrailRequest(repo, 'not a diff at all\njust noise\n'),
          deps,
        );

        expect(verdict.kind).toBe('guardrail_violation');
        if (verdict.kind !== 'guardrail_violation') return;
        if (verdict.violation.kind !== 'unenumerable_diff') throw new Error('expected unenumerable_diff');
        expect(verdict.violation.reason).not.toBe('');
        expectNothingExecuted(deps);
      },
      INTEGRATION_TIMEOUT,
    );

    it(
      'a fix diff touching verification config is an invariance violation, executing no test run',
      async () => {
        repo = await createTempGitRepo();
        const deps = spyingDeps();

        const verdict = await runCounterfactual(
          guardrailRequest(repo, emitFakeAdapter('touches-test-config').fixDiff),
          deps,
        );

        expect(verdict.kind).toBe('guardrail_violation');
        if (verdict.kind !== 'guardrail_violation') return;
        expect(verdict.violation).toEqual({ kind: 'invariance', paths: ['vitest.config.ts'] });
        expectNothingExecuted(deps);
      },
      INTEGRATION_TIMEOUT,
    );

    it(
      'a fix diff exceeding limits.max_files_changed is cap_exceeded, executing no test run',
      async () => {
        repo = await createTempGitRepo();
        const deps = spyingDeps();

        const verdict = await runCounterfactual(
          guardrailRequest(repo, emitFakeAdapter('too-many-files').fixDiff),
          deps,
        );

        expect(verdict).toEqual({ kind: 'cap_exceeded', fileCount: 11, limit: 10 });
        expectNothingExecuted(deps);
      },
      INTEGRATION_TIMEOUT,
    );
  });

  describe('zero-secret contract', () => {
    it('buildZeroSecretEnv keeps only allowlisted keys, dropping everything secret-like', () => {
      const env = buildZeroSecretEnv({
        PATH: '/usr/bin',
        HOME: '/home/user',
        GITHUB_TOKEN: 'hostile',
        AWS_SECRET_ACCESS_KEY: 'hostile',
        NODE_OPTIONS: '--require=evil',
      });

      expect(Object.keys(env).sort()).toEqual(['HOME', 'PATH']);
    });

    it(
      'the child process env contains nothing beyond the allowlist',
      async () => {
        repo = await createTempGitRepo();
        const dumpDir = await mkdtemp(join(tmpdir(), 'amends-env-dump-'));
        const dumpPath = join(dumpDir, 'env-keys.jsonl');
        const envDumpingArtifact = [
          "import { appendFileSync } from 'node:fs';",
          "import assert from 'node:assert/strict';",
          "import { total } from './src/total.js';",
          '',
          `appendFileSync(${JSON.stringify(dumpPath)}, JSON.stringify(Object.keys(process.env)) + '\\n');`,
          'assert.equal(total([{ price: 5, quantity: 3 }]), 15);',
          '',
        ].join('\n');

        try {
          const verdict = await runCounterfactual(
            requestFor(repo, envDumpingArtifact),
            realDeps(),
          );
          expect(verdict.kind).toBe('counterfactual');

          const dumpedRuns = (await readFile(dumpPath, 'utf8')).trim().split('\n');
          expect(dumpedRuns).toHaveLength(2);
          for (const dumped of dumpedRuns) {
            for (const key of JSON.parse(dumped) as string[]) {
              // macOS spawn injects __CF_USER_TEXT_ENCODING into any child env.
              const allowed = ZERO_SECRET_ENV_ALLOWLIST.includes(key) || key.startsWith('__CF');
              expect(allowed, `unexpected env key in child process: ${key}`).toBe(true);
            }
          }
        } finally {
          await rm(dumpDir, { recursive: true, force: true });
        }
      },
      INTEGRATION_TIMEOUT,
    );
  });
});
