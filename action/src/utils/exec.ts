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
  /** Cap on retained stdout/stderr bytes (each). Callers that only need a failure signature set this; adapter-JSON callers omit it. */
  maxCapturedBytes?: number;
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

/** Chunked capture: O(1) appends joined once at exit, retaining at most `cap` bytes. */
const createCapture = (cap: number): { push(chunk: Buffer): void; text(): string } => {
  const chunks: Buffer[] = [];
  let retained = 0;
  return {
    push: (chunk) => {
      if (retained >= cap) return;
      const room = cap - retained;
      const kept = chunk.length > room ? chunk.subarray(0, room) : chunk;
      chunks.push(kept);
      retained += kept.length;
    },
    text: () => Buffer.concat(chunks).toString('utf8'),
  };
};

export const createCommandRunner = (): CommandRunner => ({
  run: (request) =>
    new Promise((resolvePromise, rejectPromise) => {
      const child = spawn(request.command, request.args, {
        cwd: request.cwd,
        env: request.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      const cap = request.maxCapturedBytes ?? Number.MAX_SAFE_INTEGER;
      const stdout = createCapture(cap);
      const stderr = createCapture(cap);
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, request.timeoutMs);

      child.stdout.on('data', (chunk: Buffer) => {
        stdout.push(chunk);
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr.push(chunk);
      });
      child.on('error', (error) => {
        clearTimeout(timer);
        rejectPromise(error);
      });
      child.on('close', (exitCode) => {
        clearTimeout(timer);
        resolvePromise(
          timedOut
            ? { kind: 'timed_out', timeoutMs: request.timeoutMs }
            : { kind: 'completed', exitCode: exitCode ?? 1, stdout: stdout.text(), stderr: stderr.text() },
        );
      });
    }),
});
