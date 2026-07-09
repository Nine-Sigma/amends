import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ADAPTER_INPUT_ENV_VAR } from '../src/adapter/run-adapter.js';
import { parseAdapterResult } from '../src/adapter/parse-result.js';
import { createCommandRunner } from '../src/utils/exec.js';
import { createFileReader, createFileWriter } from '../src/utils/fs.js';
import { createTempGitRepo } from '../tests/helpers/temp-git.js';
import { CLAUDE_CLI_COMMAND } from './claude-code.js';
import type { ClaudeCodeDeps } from './claude-code.js';
import { runAdapterCli } from './cli.js';

const INTEGRATION_TIMEOUT = 30_000;

interface RecordedIo {
  stdoutLines: string[];
  stderrLines: string[];
  stdout(line: string): void;
  stderr(line: string): void;
}

const recordedIo = (): RecordedIo => {
  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];
  return {
    stdoutLines,
    stderrLines,
    stdout: (line) => stdoutLines.push(line),
    stderr: (line) => stderrLines.push(line),
  };
};

const unusedDeps = (): ClaudeCodeDeps => ({
  runner: { run: () => Promise.reject(new Error('must not run')) },
  reader: { read: () => Promise.reject(new Error('must not read')) },
  writer: { write: () => Promise.reject(new Error('must not write')) },
});

describe('runAdapterCli', () => {
  it('exits 1 with a structured error when the input env var is missing', async () => {
    const io = recordedIo();

    const exitCode = await runAdapterCli({}, unusedDeps(), io);

    expect(exitCode).toBe(1);
    expect(io.stdoutLines).toEqual([]);
    const error = JSON.parse(io.stderrLines.join('')) as { kind: string };
    expect(error.kind).toBe('invalid_adapter_input');
  });

  it('exits 1 with a structured error on malformed or incomplete input JSON', async () => {
    const io = recordedIo();

    const malformed = await runAdapterCli({ [ADAPTER_INPUT_ENV_VAR]: 'not json {' }, unusedDeps(), io);
    expect(malformed).toBe(1);

    const incomplete = await runAdapterCli(
      { [ADAPTER_INPUT_ENV_VAR]: JSON.stringify({ checkout_path: '/x' }) },
      unusedDeps(),
      io,
    );
    expect(incomplete).toBe(1);
    expect(io.stdoutLines).toEqual([]);
  });

  it(
    'runs the claude-code adapter end to end under a trimmed env: a real repo with edits yields conformant result JSON',
    async () => {
      const repo = await createTempGitRepo();
      const promptDir = await mkdtemp(join(tmpdir(), 'amends-cli-'));
      try {
        const promptPath = join(promptDir, 'prompt.md');
        await writeFile(promptPath, '# fix pass prompt', 'utf8');
        const realRunner = createCommandRunner();
        const claudeStdout = JSON.stringify({ subtype: 'success', result: 'done' });
        const deps: ClaudeCodeDeps = {
          runner: {
            run: async (request) => {
              if (request.command !== CLAUDE_CLI_COMMAND) return realRunner.run(request);
              // The "agent" edits a file, like a real claude run would.
              await writeFile(join(repo.repoPath, 'src/total.js'), 'export const total = () => 15;\n');
              return { kind: 'completed', exitCode: 0, stdout: claudeStdout, stderr: '' };
            },
          },
          reader: createFileReader(),
          writer: createFileWriter(),
        };
        const io = recordedIo();
        const env = {
          PATH: process.env['PATH'] ?? '',
          [ADAPTER_INPUT_ENV_VAR]: JSON.stringify({
            checkout_path: repo.repoPath,
            case_file_path: join(promptDir, 'case-file.json'),
            prompt_path: promptPath,
            model_config: { model: 'claude-sonnet-5' },
          }),
        };

        const exitCode = await runAdapterCli(env, deps, io);

        expect(io.stderrLines).toEqual([]);
        expect(exitCode).toBe(0);
        const parsed = parseAdapterResult(JSON.parse(io.stdoutLines.join('')));
        expect(parsed.ok).toBe(true);
      } finally {
        await repo.cleanup();
        await rm(promptDir, { recursive: true, force: true });
      }
    },
    INTEGRATION_TIMEOUT,
  );

  it('maps a non-ok adapter outcome to exit 1 with the structured outcome on stderr', async () => {
    const io = recordedIo();
    const deps: ClaudeCodeDeps = {
      runner: {
        run: () =>
          Promise.resolve({ kind: 'completed', exitCode: 2, stdout: '', stderr: 'no credentials' }),
      },
      reader: { read: () => Promise.resolve('prompt') },
      writer: { write: () => Promise.resolve() },
    };

    const exitCode = await runAdapterCli(
      {
        [ADAPTER_INPUT_ENV_VAR]: JSON.stringify({
          checkout_path: '/tmp/nowhere',
          case_file_path: '/tmp/case.json',
          prompt_path: '/tmp/prompt.md',
          model_config: { model: 'm' },
        }),
      },
      deps,
      io,
    );

    expect(exitCode).toBe(1);
    const outcome = JSON.parse(io.stderrLines.join('')) as { kind: string };
    expect(outcome.kind).toBe('agent_failed');
  });
});
