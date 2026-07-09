import { describe, expect, it } from 'vitest';

import { ADAPTER_INPUT_ENV_VAR, runAdapter } from './run-adapter.js';
import type { AdapterInvocation } from './run-adapter.js';
import type { CommandRequest, CommandRunner } from '../utils/exec.js';
import {
  FAKE_ADAPTER_SCENARIOS,
  emitFakeAdapter,
  fakeAdapterRunner,
} from '../../tests/helpers/fake-adapter.js';

const invocation = (): AdapterInvocation => ({
  command: 'fake-adapter',
  args: ['--scenario', 'happy-tier1'],
  input: {
    checkout_path: '/tmp/checkout',
    case_file_path: '/tmp/case-file.json',
    prompt_path: '/runner/tmp/amends/prompt.md',
    model_config: { model: 'claude-sonnet-5' },
  },
  env: {},
  timeoutMs: 5_000,
});

const stdoutRunner = (stdout: string, exitCode = 0): CommandRunner => ({
  run: () => Promise.resolve({ kind: 'completed', exitCode, stdout, stderr: '' }),
});

const conformantResult = (): Record<string, unknown> => ({
  branch_ref: 'amends/fix-abc123',
  fix_diff_path: 'amends-out/fix.patch',
  artifact_paths: ['src/checkout/total.counterfactual.test.ts'],
  usage: {
    input_tokens: 1000,
    output_tokens: 200,
    estimated_usd: 0.05,
    usage_source: 'reported',
  },
});

describe('runAdapter', () => {
  it('rejects result JSON missing the usage block as nonconforming with a structured error', async () => {
    const withoutUsage = conformantResult();
    delete withoutUsage['usage'];

    const outcome = await runAdapter(invocation(), stdoutRunner(JSON.stringify(withoutUsage)));

    expect(outcome.kind).toBe('nonconforming');
    if (outcome.kind !== 'nonconforming') throw new Error('expected nonconforming');
    expect(outcome.errors).toContainEqual({
      path: 'usage',
      reason: 'required field is missing',
    });
  });

  it('accepts a conformant result', async () => {
    const outcome = await runAdapter(invocation(), stdoutRunner(JSON.stringify(conformantResult())));

    expect(outcome.kind).toBe('ok');
    if (outcome.kind !== 'ok') throw new Error('expected ok');
    expect(outcome.result.branch_ref).toBe('amends/fix-abc123');
    expect(outcome.result.fix_diff_path).toBe('amends-out/fix.patch');
    expect(outcome.result.artifact_paths).toEqual(['src/checkout/total.counterfactual.test.ts']);
  });

  it('runs in the checkout with the explicit env map, timeout, and the serialized input transport', async () => {
    const seen: CommandRequest[] = [];
    const runner: CommandRunner = {
      run: (request) => {
        seen.push(request);
        return Promise.resolve({
          kind: 'completed',
          exitCode: 0,
          stdout: JSON.stringify(conformantResult()),
          stderr: '',
        });
      },
    };

    await runAdapter(invocation(), runner);

    expect(seen).toHaveLength(1);
    const request = seen[0];
    if (request === undefined) throw new Error('unreachable');
    expect(request.command).toBe('fake-adapter');
    expect(request.args).toEqual(['--scenario', 'happy-tier1']);
    expect(request.cwd).toBe('/tmp/checkout');
    expect(request.timeoutMs).toBe(5_000);
    expect(JSON.parse(request.env[ADAPTER_INPUT_ENV_VAR] ?? '')).toEqual(invocation().input);
    expect(Object.keys(request.env)).toEqual([ADAPTER_INPUT_ENV_VAR]);
  });

  it('maps a spawn ENOENT (missing adapter executable) to a structured spawn_failed outcome', async () => {
    const enoent = Object.assign(new Error('spawn fake-adapter ENOENT'), { code: 'ENOENT' });
    const runner: CommandRunner = { run: () => Promise.reject(enoent) };

    const outcome = await runAdapter(invocation(), runner);

    expect(outcome.kind).toBe('spawn_failed');
    if (outcome.kind !== 'spawn_failed') throw new Error('expected spawn_failed');
    expect(outcome.detail).toContain('ENOENT');
  });

  it('still rejects on non-ENOENT runner faults — those are environment faults', async () => {
    const fault = Object.assign(new Error('EPERM'), { code: 'EPERM' });
    const runner: CommandRunner = { run: () => Promise.reject(fault) };

    await expect(runAdapter(invocation(), runner)).rejects.toThrow('EPERM');
  });

  it('reports non-zero exit as a distinct structured failure', async () => {
    const runner: CommandRunner = {
      run: () =>
        Promise.resolve({ kind: 'completed', exitCode: 3, stdout: '', stderr: 'model quota exhausted' }),
    };

    const outcome = await runAdapter(invocation(), runner);

    expect(outcome).toEqual({ kind: 'nonzero_exit', exitCode: 3, stderr: 'model quota exhausted' });
  });

  it('reports a timeout as a distinct structured failure', async () => {
    const runner: CommandRunner = {
      run: () => Promise.resolve({ kind: 'timed_out', timeoutMs: 5_000 }),
    };

    const outcome = await runAdapter(invocation(), runner);

    expect(outcome).toEqual({ kind: 'timeout', timeoutMs: 5_000 });
  });

  it('reports malformed JSON as a distinct structured failure', async () => {
    const outcome = await runAdapter(invocation(), stdoutRunner('not json {'));

    expect(outcome.kind).toBe('malformed_json');
  });

  it('rejects an unknown usage_source value with a structured error at its path', async () => {
    const result = conformantResult();
    result['usage'] = { ...(result['usage'] as object), usage_source: 'guessed' };

    const outcome = await runAdapter(invocation(), stdoutRunner(JSON.stringify(result)));

    expect(outcome.kind).toBe('nonconforming');
    if (outcome.kind !== 'nonconforming') throw new Error('expected nonconforming');
    expect(outcome.errors).toContainEqual({
      path: 'usage.usage_source',
      reason: "expected one of 'reported' | 'estimated' | 'unavailable'",
    });
  });

  it.each([
    ['branch_ref', 'branch_ref'],
    ['fix_diff_path', 'fix_diff_path'],
    ['artifact_paths', 'artifact_paths'],
  ])('rejects a result missing %s with an error naming its path', async (field, path) => {
    const result = conformantResult();
    delete result[field];

    const outcome = await runAdapter(invocation(), stdoutRunner(JSON.stringify(result)));

    expect(outcome.kind).toBe('nonconforming');
    if (outcome.kind !== 'nonconforming') throw new Error('expected nonconforming');
    expect(outcome.errors).toContainEqual({ path, reason: 'required field is missing' });
  });

  it("preserves usage_source 'unavailable' with null figures (usage honesty rule)", async () => {
    const outcome = await runAdapter(invocation(), fakeAdapterRunner('no-artifact'));

    expect(outcome.kind).toBe('ok');
    if (outcome.kind !== 'ok') throw new Error('expected ok');
    expect(outcome.result.usage).toEqual({
      input_tokens: null,
      output_tokens: null,
      estimated_usd: null,
      usage_source: 'unavailable',
    });
  });

  it('preserves unmodeled result fields (tolerant reader)', async () => {
    const result = conformantResult();
    result['agent_notes'] = 'self-described integration coverage';
    result['claimed_tier'] = 2;

    const outcome = await runAdapter(invocation(), stdoutRunner(JSON.stringify(result)));

    expect(outcome.kind).toBe('ok');
    if (outcome.kind !== 'ok') throw new Error('expected ok');
    expect(outcome.result['agent_notes']).toBe('self-described integration coverage');
    expect(outcome.result['claimed_tier']).toBe(2);
  });
});

describe('fake adapter scenarios', () => {
  it.each(FAKE_ADAPTER_SCENARIOS)('%s emits conformant result JSON', async (scenario) => {
    const outcome = await runAdapter(invocation(), fakeAdapterRunner(scenario));

    expect(outcome.kind).toBe('ok');
    if (outcome.kind !== 'ok') throw new Error('expected ok');
    expect(outcome.result.branch_ref).toBe(`amends/fix-${scenario}`);
    expect(FAKE_ADAPTER_SCENARIOS.includes(scenario)).toBe(true);
  });

  it('declares artifact paths separable from the fix diff paths', () => {
    const emit = emitFakeAdapter('happy-tier1');

    const artifactPaths = Object.keys(emit.artifactFiles);
    expect(artifactPaths).toEqual(['src/checkout/total.counterfactual.test.ts']);
    expect(emit.fixDiffPaths).toEqual(['src/checkout/total.ts']);
    expect(emit.fixDiffPaths.some((path) => artifactPaths.includes(path))).toBe(false);
    expect(emit.fixDiff).toContain('a/src/checkout/total.ts');
    expect(emit.fixDiff).not.toContain('counterfactual.test');
  });

  it('no-artifact declares an empty artifact list', () => {
    const emit = emitFakeAdapter('no-artifact');

    expect(Object.keys(emit.artifactFiles)).toEqual([]);
    expect(JSON.parse(emit.resultJson)).toMatchObject({ artifact_paths: [] });
  });

  it('too-many-files exceeds the default max_files_changed cap of 10', () => {
    const emit = emitFakeAdapter('too-many-files');

    expect(emit.fixDiffPaths.length).toBeGreaterThan(10);
  });

  it('guardrail scenarios touch their target paths in the fix diff', () => {
    expect(emitFakeAdapter('touches-workflow').fixDiffPaths).toContain(
      '.github/workflows/release.yml',
    );
    expect(emitFakeAdapter('touches-test-config').fixDiffPaths).toContain('vitest.config.ts');
  });
});
