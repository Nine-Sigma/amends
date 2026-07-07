import type { ParseError } from '../utils/narrow.js';
import type { CommandRunner } from '../utils/exec.js';
import { parseAdapterResult } from './parse-result.js';
import type { AdapterInput, AdapterResult } from './types.js';

/** How to spawn one adapter run; args carry the adapter-specific mapping of the input. */
export interface AdapterInvocation {
  command: string;
  args: string[];
  input: AdapterInput;
  /** Explicit, complete child env — built from an allowlist by the caller. */
  env: Record<string, string>;
  timeoutMs: number;
}

export type RunAdapterOutcome =
  | { kind: 'ok'; result: AdapterResult }
  | { kind: 'nonzero_exit'; exitCode: number; stderr: string }
  | { kind: 'timeout'; timeoutMs: number }
  | { kind: 'malformed_json'; detail: string }
  | { kind: 'nonconforming'; errors: ParseError[] };

/**
 * Spawns an adapter and narrows its stdout as untrusted result JSON. Every
 * failure mode is a distinct structured outcome; nothing throws for control
 * flow (a runner-level spawn error still rejects — that is an environment
 * fault, not adapter output).
 */
export const runAdapter = async (
  invocation: AdapterInvocation,
  runner: CommandRunner,
): Promise<RunAdapterOutcome> => {
  const outcome = await runner.run({
    command: invocation.command,
    args: invocation.args,
    cwd: invocation.input.checkout_path,
    env: invocation.env,
    timeoutMs: invocation.timeoutMs,
  });

  if (outcome.kind === 'timed_out') {
    return { kind: 'timeout', timeoutMs: outcome.timeoutMs };
  }
  if (outcome.exitCode !== 0) {
    return { kind: 'nonzero_exit', exitCode: outcome.exitCode, stderr: outcome.stderr };
  }

  let json: unknown;
  try {
    json = JSON.parse(outcome.stdout);
  } catch (error) {
    return { kind: 'malformed_json', detail: error instanceof Error ? error.message : String(error) };
  }

  const parsed = parseAdapterResult(json);
  if (!parsed.ok) {
    return { kind: 'nonconforming', errors: parsed.errors };
  }
  return { kind: 'ok', result: { ...parsed.body, exit_code: outcome.exitCode } };
};
