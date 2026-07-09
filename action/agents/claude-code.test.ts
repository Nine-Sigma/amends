import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { createTempGitRepo } from '../tests/helpers/temp-git.js';
import type { AdapterInput } from '../src/adapter/types.js';
import { createCommandRunner } from '../src/utils/exec.js';
import type { CommandRequest, CommandResult, CommandRunner } from '../src/utils/exec.js';
import { createFileReader, createFileWriter } from '../src/utils/fs.js';
import type { FileReader, FileWriter } from '../src/utils/fs.js';
import {
  ADAPTER_SCRATCH_DIR,
  CLAUDE_CLI_COMMAND,
  CLAUDE_CODE_BRANCH_REF,
  FIX_DIFF_OUTPUT_PATH,
  buildClaudeCliInvocation,
  extractUsage,
  runClaudeCodeAdapter,
} from './claude-code.js';
import type { ClaudeCodeDeps, ClaudeCodeRequest } from './claude-code.js';

const fixturesDir = resolve(import.meta.dirname, 'fixtures');
const fixture = (name: string): string => readFileSync(join(fixturesDir, name), 'utf8');

const CHECKOUT = '/tmp/amends-checkout';
const PROMPT_PATH = join(CHECKOUT, '.amends/prompt.md');
const PROMPT_CONTENT = '# Amends fix pass\n\nassembled prompt body';

const adapterInput: AdapterInput = {
  checkout_path: CHECKOUT,
  case_file_path: '/tmp/case-file.json',
  prompt_path: PROMPT_PATH,
  model_config: { model: 'claude-sonnet-5' },
};

const baseRequest: ClaudeCodeRequest = {
  input: adapterInput,
  promptPath: PROMPT_PATH,
  timeoutMs: 600_000,
  env: { PATH: '/usr/bin', HOME: '/home/runner', ANTHROPIC_API_KEY: 'test-key' },
};

const HAPPY_PORCELAIN = [
  ' M src/checkout/total.ts',
  '?? src/checkout/total.counterfactual.test.ts',
  '?? .amends/prompt.md',
  '',
].join('\n');

const HAPPY_DIFF = 'diff --git a/src/checkout/total.ts b/src/checkout/total.ts\n';

interface ScriptedDeps extends ClaudeCodeDeps {
  calls: CommandRequest[];
  writes: Array<{ path: string; content: string }>;
}

const scriptedDeps = (script: {
  claude?: CommandResult;
  status?: string;
  diff?: string;
}): ScriptedDeps => {
  const calls: CommandRequest[] = [];
  const writes: Array<{ path: string; content: string }> = [];
  const runner: CommandRunner = {
    run: (request) => {
      calls.push(request);
      if (request.command === CLAUDE_CLI_COMMAND) {
        return Promise.resolve(
          script.claude ??
            ({ kind: 'completed', exitCode: 0, stdout: fixture('claude-cli-success.json'), stderr: '' } as CommandResult),
        );
      }
      if (request.args[0] === 'status') {
        return Promise.resolve({
          kind: 'completed',
          exitCode: 0,
          stdout: script.status ?? HAPPY_PORCELAIN,
          stderr: '',
        } as CommandResult);
      }
      if (request.args[0] === 'diff') {
        return Promise.resolve({
          kind: 'completed',
          exitCode: 0,
          stdout: script.diff ?? HAPPY_DIFF,
          stderr: '',
        } as CommandResult);
      }
      return Promise.resolve({ kind: 'completed', exitCode: 0, stdout: '', stderr: '' } as CommandResult);
    },
  };
  const reader: FileReader = {
    read: (path) =>
      path === PROMPT_PATH ? Promise.resolve(PROMPT_CONTENT) : Promise.reject(new Error(`unexpected read ${path}`)),
  };
  const writer: FileWriter = {
    write: (path, content) => {
      writes.push({ path, content });
      return Promise.resolve();
    },
  };
  return { runner, reader, writer, calls, writes };
};

describe('buildClaudeCliInvocation', () => {
  it('builds a headless claude invocation over the prompt content with checkout cwd', () => {
    const invocation = buildClaudeCliInvocation(baseRequest, PROMPT_CONTENT);
    expect(invocation.command).toBe(CLAUDE_CLI_COMMAND);
    expect(invocation.cwd).toBe(CHECKOUT);
    expect(invocation.env).toEqual(baseRequest.env);
    expect(invocation.timeoutMs).toBe(600_000);
    const promptFlag = invocation.args.indexOf('-p');
    expect(promptFlag).toBeGreaterThanOrEqual(0);
    expect(invocation.args[promptFlag + 1]).toBe(PROMPT_CONTENT);
    const modelFlag = invocation.args.indexOf('--model');
    expect(invocation.args[modelFlag + 1]).toBe('claude-sonnet-5');
    const formatFlag = invocation.args.indexOf('--output-format');
    expect(invocation.args[formatFlag + 1]).toBe('json');
  });
});

describe('extractUsage', () => {
  it('maps a recorded claude result with usage to usage_source reported', () => {
    const output = JSON.parse(fixture('claude-cli-success.json')) as Record<string, unknown>;
    expect(extractUsage(output)).toEqual({
      input_tokens: 3134,
      output_tokens: 892,
      estimated_usd: 0.31,
      usage_source: 'reported',
    });
  });

  it('maps a recorded claude result without usage to usage_source unavailable with null figures', () => {
    const output = JSON.parse(fixture('claude-cli-no-usage.json')) as Record<string, unknown>;
    expect(extractUsage(output)).toEqual({
      input_tokens: null,
      output_tokens: null,
      estimated_usd: null,
      usage_source: 'unavailable',
    });
  });

  it('treats malformed usage figures as unavailable, never crashing', () => {
    const output = { usage: { input_tokens: 'lots', output_tokens: 892 } };
    expect(extractUsage(output).usage_source).toBe('unavailable');
  });
});

describe('runClaudeCodeAdapter', () => {
  it('maps a recorded claude run to a conformant AdapterResult body', async () => {
    const deps = scriptedDeps({});
    const outcome = await runClaudeCodeAdapter(baseRequest, deps);
    expect(outcome.kind).toBe('ok');
    if (outcome.kind !== 'ok') return;
    expect(outcome.result.branch_ref).toBe(CLAUDE_CODE_BRANCH_REF);
    expect(outcome.result.fix_diff_path).toBe(FIX_DIFF_OUTPUT_PATH);
    expect(outcome.result.artifact_paths).toEqual(['src/checkout/total.counterfactual.test.ts']);
    expect(outcome.result.usage).toEqual({
      input_tokens: 3134,
      output_tokens: 892,
      estimated_usd: 0.31,
      usage_source: 'reported',
    });
    expect(deps.writes).toEqual([{ path: join(CHECKOUT, FIX_DIFF_OUTPUT_PATH), content: HAPPY_DIFF }]);
  });

  it('reads the prompt file and passes its content to the claude CLI', async () => {
    const deps = scriptedDeps({});
    await runClaudeCodeAdapter(baseRequest, deps);
    const claudeCall = deps.calls.find((call) => call.command === CLAUDE_CLI_COMMAND);
    expect(claudeCall).toBeDefined();
    expect(claudeCall?.args).toContain(PROMPT_CONTENT);
    expect(claudeCall?.cwd).toBe(CHECKOUT);
  });

  it('excludes artifact files and the scratch dir from the captured fix diff', async () => {
    const deps = scriptedDeps({});
    await runClaudeCodeAdapter(baseRequest, deps);
    const diffCall = deps.calls.find((call) => call.args[0] === 'diff');
    expect(diffCall?.args).toContain(`:(exclude)${ADAPTER_SCRATCH_DIR}`);
    expect(diffCall?.args).toContain(':(exclude)src/checkout/total.counterfactual.test.ts');
  });

  it('returns agent_failed on a nonzero claude exit', async () => {
    const deps = scriptedDeps({
      claude: { kind: 'completed', exitCode: 2, stdout: '', stderr: 'invalid api key' },
    });
    const outcome = await runClaudeCodeAdapter(baseRequest, deps);
    expect(outcome).toEqual({ kind: 'agent_failed', exitCode: 2, stderr: 'invalid api key' });
  });

  it('returns agent_timed_out when the claude run exceeds its budget', async () => {
    const deps = scriptedDeps({ claude: { kind: 'timed_out', timeoutMs: 600_000 } });
    const outcome = await runClaudeCodeAdapter(baseRequest, deps);
    expect(outcome).toEqual({ kind: 'agent_timed_out', timeoutMs: 600_000 });
  });

  it('returns a structured nonconforming_output for non-JSON stdout — never a crash', async () => {
    const deps = scriptedDeps({
      claude: { kind: 'completed', exitCode: 0, stdout: 'I fixed it! (plain text)', stderr: '' },
    });
    const outcome = await runClaudeCodeAdapter(baseRequest, deps);
    expect(outcome.kind).toBe('nonconforming_output');
    if (outcome.kind !== 'nonconforming_output') return;
    expect(outcome.errors[0]?.path).toBe('$');
  });

  it('returns a structured nonconforming_output for JSON that is not an object', async () => {
    const deps = scriptedDeps({
      claude: { kind: 'completed', exitCode: 0, stdout: '["not","a","result"]', stderr: '' },
    });
    const outcome = await runClaudeCodeAdapter(baseRequest, deps);
    expect(outcome.kind).toBe('nonconforming_output');
  });

  it('surfaces a claude-reported error as agent_reported_error', async () => {
    const deps = scriptedDeps({
      claude: { kind: 'completed', exitCode: 0, stdout: fixture('claude-cli-error.json'), stderr: '' },
    });
    const outcome = await runClaudeCodeAdapter(baseRequest, deps);
    expect(outcome.kind).toBe('agent_reported_error');
    if (outcome.kind !== 'agent_reported_error') return;
    expect(outcome.detail).toContain('error_max_turns');
  });

  it('returns no_changes when the working tree holds nothing beyond the scratch dir', async () => {
    const deps = scriptedDeps({ status: '?? .amends/prompt.md\n' });
    const outcome = await runClaudeCodeAdapter(baseRequest, deps);
    expect(outcome).toEqual({ kind: 'no_changes' });
    expect(deps.writes).toEqual([]);
  });

  it(
    'against a real repo: prompt written out-of-tree + no edits is no_changes, with real git status',
    async () => {
      const repo = await createTempGitRepo();
      const promptDir = await mkdtemp(join(tmpdir(), 'amends-prompt-'));
      try {
        const promptPath = join(promptDir, 'prompt.md');
        await writeFile(promptPath, PROMPT_CONTENT, 'utf8');
        const realRunner = createCommandRunner();
        const deps: ClaudeCodeDeps = {
          runner: {
            run: (request) =>
              request.command === CLAUDE_CLI_COMMAND
                ? Promise.resolve({
                    kind: 'completed',
                    exitCode: 0,
                    stdout: fixture('claude-cli-success.json'),
                    stderr: '',
                  })
                : realRunner.run(request),
          },
          reader: createFileReader(),
          writer: createFileWriter(),
        };

        const outcome = await runClaudeCodeAdapter(
          {
            input: { ...adapterInput, checkout_path: repo.repoPath },
            promptPath,
            timeoutMs: 30_000,
            env: { PATH: process.env['PATH'] ?? '' },
          },
          deps,
        );

        expect(outcome).toEqual({ kind: 'no_changes' });
      } finally {
        await repo.cleanup();
        await rm(promptDir, { recursive: true, force: true });
      }
    },
    30_000,
  );

  it('preserves usage_source unavailable from a usage-less claude result', async () => {
    const deps = scriptedDeps({
      claude: { kind: 'completed', exitCode: 0, stdout: fixture('claude-cli-no-usage.json'), stderr: '' },
    });
    const outcome = await runClaudeCodeAdapter(baseRequest, deps);
    expect(outcome.kind).toBe('ok');
    if (outcome.kind !== 'ok') return;
    expect(outcome.result.usage.usage_source).toBe('unavailable');
  });
});
