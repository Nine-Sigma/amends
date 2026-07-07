/**
 * claude-code adapter (US-012): drives the Claude Code CLI in headless mode
 * against the fix-stage checkout and maps its run to a conformant
 * AdapterResult body (§3.4). Offline-verifiable core only — the runnable
 * process entry (argv parsing + printing the result JSON on stdout for
 * run-adapter.ts) ships with dist bundling; see README.md.
 *
 * Claude output is untrusted adapter output: parsed from unknown, every
 * failure mode a structured outcome, nothing throws for control flow (git
 * failures are environment faults and reject, matching exec.ts semantics).
 */

import { join } from 'node:path';

import type { AdapterInput, AdapterResultBody, UsageBlock } from '../src/adapter/types.js';
import type { CommandRequest, CommandRunner } from '../src/utils/exec.js';
import { commandFailureSignature } from '../src/utils/exec.js';
import type { FileReader, FileWriter } from '../src/utils/fs.js';
import type { ParseError } from '../src/utils/narrow.js';
import { isRecord } from '../src/utils/narrow.js';

export const CLAUDE_CLI_COMMAND = 'claude';
/** Adapter scratch space inside the checkout; excluded from change collection and the fix diff. */
export const ADAPTER_SCRATCH_DIR = '.amends';
/** Repo-relative declared path the fix stage reads the diff from (fix.ts readDeclared). */
export const FIX_DIFF_OUTPUT_PATH = '.amends/fix.diff';
/** Symbolic ref for the adapter's work; conforms to publish.ts BRANCH_REF_PATTERN. */
export const CLAUDE_CODE_BRANCH_REF = 'amends/claude-code-fix';
/** New files whose name carries this marker are counterfactual artifacts, separable from the fix diff. */
export const COUNTERFACTUAL_ARTIFACT_MARKER = '.counterfactual.test.';

export interface ClaudeCodeRequest {
  input: AdapterInput;
  /** Absolute path to the assembled US-007 prompt file. */
  promptPath: string;
  timeoutMs: number;
  /** Explicit, complete child env — model credentials live here (fix job only, §8.1). */
  env: Record<string, string>;
}

export interface ClaudeCodeDeps {
  runner: CommandRunner;
  reader: FileReader;
  writer: FileWriter;
}

export type ClaudeCodeOutcome =
  | { kind: 'ok'; result: AdapterResultBody }
  | { kind: 'agent_failed'; exitCode: number; stderr: string }
  | { kind: 'agent_timed_out'; timeoutMs: number }
  | { kind: 'agent_reported_error'; detail: string }
  | { kind: 'nonconforming_output'; errors: ParseError[] }
  | { kind: 'no_changes' };

/**
 * Headless invocation over the assembled prompt CONTENT: CommandRunner has no
 * stdin, so the prompt file is read by the adapter and passed via -p.
 * --dangerously-skip-permissions is scoped to the disposable fix-job checkout.
 */
export const buildClaudeCliInvocation = (
  request: ClaudeCodeRequest,
  promptContent: string,
): CommandRequest => ({
  command: CLAUDE_CLI_COMMAND,
  args: [
    '-p',
    promptContent,
    '--output-format',
    'json',
    '--model',
    request.input.model_config.model,
    '--dangerously-skip-permissions',
  ],
  cwd: request.input.checkout_path,
  env: request.env,
  timeoutMs: request.timeoutMs,
});

/** Usage honesty (§3.4): figures only when claude reported them; anything short of that is 'unavailable'. */
export const extractUsage = (output: Record<string, unknown>): UsageBlock => {
  const usage = output['usage'];
  if (
    isRecord(usage) &&
    typeof usage['input_tokens'] === 'number' &&
    typeof usage['output_tokens'] === 'number'
  ) {
    return {
      input_tokens: usage['input_tokens'],
      output_tokens: usage['output_tokens'],
      estimated_usd: typeof output['total_cost_usd'] === 'number' ? output['total_cost_usd'] : null,
      usage_source: 'reported',
    };
  }
  return { input_tokens: null, output_tokens: null, estimated_usd: null, usage_source: 'unavailable' };
};

type ClaudeOutput =
  | { ok: true; output: Record<string, unknown> }
  | { ok: false; errors: ParseError[] };

const parseClaudeCliOutput = (stdout: string): ClaudeOutput => {
  let json: unknown;
  try {
    json = JSON.parse(stdout);
  } catch (error) {
    return { ok: false, errors: [{ path: '$', reason: `stdout is not valid JSON: ${error instanceof Error ? error.message : String(error)}` }] };
  }
  if (!isRecord(json)) {
    return { ok: false, errors: [{ path: '$', reason: 'expected a result object' }] };
  }
  return { ok: true, output: json };
};

const claudeReportedError = (output: Record<string, unknown>): string | undefined => {
  const subtype = typeof output['subtype'] === 'string' ? output['subtype'] : undefined;
  if (output['is_error'] !== true && (subtype === undefined || subtype === 'success')) return undefined;
  const result = typeof output['result'] === 'string' ? output['result'] : '';
  return `${subtype ?? 'unknown error'}: ${result}`.trim();
};

/** Git failures inside the adapter's own checkout are environment faults — they reject, never map to adapter outcomes. */
const runGit = async (deps: ClaudeCodeDeps, request: ClaudeCodeRequest, args: string[]): Promise<string> => {
  const result = await deps.runner.run({
    command: 'git',
    args,
    cwd: request.input.checkout_path,
    env: request.env,
    timeoutMs: request.timeoutMs,
  });
  if (result.kind === 'timed_out' || result.exitCode !== 0) {
    throw new Error(`git ${args[0] ?? ''} failed: ${commandFailureSignature(result)}`);
  }
  return result.stdout;
};

interface WorkingTreeChange {
  path: string;
  untracked: boolean;
}

const parsePorcelain = (stdout: string): WorkingTreeChange[] =>
  stdout
    .split('\n')
    .filter((line) => line.length > 3)
    .map((line) => {
      const rawPath = line.slice(3);
      const renameTarget = rawPath.split(' -> ')[1];
      return { path: renameTarget ?? rawPath, untracked: line.startsWith('??') };
    })
    .filter((change) => !change.path.startsWith(`${ADAPTER_SCRATCH_DIR}/`));

const captureFixDiff = async (
  deps: ClaudeCodeDeps,
  request: ClaudeCodeRequest,
  artifactPaths: string[],
): Promise<string> => {
  await runGit(deps, request, ['add', '-A']);
  const excludes = [ADAPTER_SCRATCH_DIR, ...artifactPaths].map((path) => `:(exclude)${path}`);
  return runGit(deps, request, ['diff', '--cached', '--', '.', ...excludes]);
};

export const runClaudeCodeAdapter = async (
  request: ClaudeCodeRequest,
  deps: ClaudeCodeDeps,
): Promise<ClaudeCodeOutcome> => {
  const promptContent = await deps.reader.read(request.promptPath);
  const claudeRun = await deps.runner.run(buildClaudeCliInvocation(request, promptContent));
  if (claudeRun.kind === 'timed_out') return { kind: 'agent_timed_out', timeoutMs: claudeRun.timeoutMs };
  if (claudeRun.exitCode !== 0) {
    return { kind: 'agent_failed', exitCode: claudeRun.exitCode, stderr: claudeRun.stderr };
  }

  const parsed = parseClaudeCliOutput(claudeRun.stdout);
  if (!parsed.ok) return { kind: 'nonconforming_output', errors: parsed.errors };
  const reportedError = claudeReportedError(parsed.output);
  if (reportedError !== undefined) return { kind: 'agent_reported_error', detail: reportedError };

  const changes = parsePorcelain(await runGit(deps, request, ['status', '--porcelain']));
  if (changes.length === 0) return { kind: 'no_changes' };
  const artifactPaths = changes
    .filter((change) => change.untracked && change.path.includes(COUNTERFACTUAL_ARTIFACT_MARKER))
    .map((change) => change.path);

  const fixDiff = await captureFixDiff(deps, request, artifactPaths);
  await deps.writer.write(join(request.input.checkout_path, FIX_DIFF_OUTPUT_PATH), fixDiff);

  return {
    kind: 'ok',
    result: {
      branch_ref: CLAUDE_CODE_BRANCH_REF,
      fix_diff_path: FIX_DIFF_OUTPUT_PATH,
      artifact_paths: artifactPaths,
      usage: extractUsage(parsed.output),
    },
  };
};
