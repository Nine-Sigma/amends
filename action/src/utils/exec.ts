import { spawn } from 'node:child_process';

/**
 * Injected command execution boundary. The env map is explicit and complete —
 * the child sees nothing beyond it (zero-secret contract, §8.1); callers
 * construct it from an allowlist, never from process.env wholesale.
 */
export interface CommandRequest {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
}

export type CommandResult =
  | { kind: 'completed'; exitCode: number; stdout: string; stderr: string }
  | { kind: 'timed_out'; timeoutMs: number };

export interface CommandRunner {
  run(request: CommandRequest): Promise<CommandResult>;
}

const MAX_SIGNATURE_OUTPUT = 400;

/** Deterministic short signature of a failed command, comparable across identical runs. */
export const commandFailureSignature = (result: CommandResult): string => {
  if (result.kind === 'timed_out') return `timed_out after ${result.timeoutMs}ms`;
  const output = (result.stderr.trim() || result.stdout.trim()).slice(0, MAX_SIGNATURE_OUTPUT);
  return `exit ${result.exitCode}: ${output}`;
};

export const createCommandRunner = (): CommandRunner => ({
  run: (request) =>
    new Promise((resolvePromise, rejectPromise) => {
      const child = spawn(request.command, request.args, {
        cwd: request.cwd,
        env: request.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, request.timeoutMs);

      child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
      child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
      child.on('error', (error) => {
        clearTimeout(timer);
        rejectPromise(error);
      });
      child.on('close', (exitCode) => {
        clearTimeout(timer);
        resolvePromise(
          timedOut
            ? { kind: 'timed_out', timeoutMs: request.timeoutMs }
            : { kind: 'completed', exitCode: exitCode ?? 1, stdout, stderr },
        );
      });
    }),
});
