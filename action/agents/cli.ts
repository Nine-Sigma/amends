#!/usr/bin/env node
/**
 * Process entry for the claude-code adapter: reads AdapterInput from the
 * AMENDS_ADAPTER_INPUT env var (the transport run-adapter.ts sets), drives
 * runClaudeCodeAdapter, and prints the result JSON on stdout (exit 0) or the
 * structured non-ok outcome on stderr (exit 1). The env this process received
 * is the fix stage's allowlisted map — it is passed through to the claude
 * child verbatim.
 */

import { pathToFileURL } from 'node:url';

import { ADAPTER_INPUT_ENV_VAR } from '../src/adapter/run-adapter.js';
import type { AdapterInput } from '../src/adapter/types.js';
import { createCommandRunner } from '../src/utils/exec.js';
import { createFileReader, createFileWriter } from '../src/utils/fs.js';
import { isRecord, requireString } from '../src/utils/narrow.js';
import type { ParseError } from '../src/utils/narrow.js';
import { runClaudeCodeAdapter } from './claude-code.js';
import type { ClaudeCodeDeps } from './claude-code.js';

const DEFAULT_CLI_TIMEOUT_MS = 600_000;

type EnvMap = Readonly<Record<string, string | undefined>>;

export interface AdapterCliIo {
  stdout(line: string): void;
  stderr(line: string): void;
}

type ParsedInput = { ok: true; input: AdapterInput } | { ok: false; errors: ParseError[] };

const parseAdapterInput = (raw: string | undefined): ParsedInput => {
  if (raw === undefined || raw === '') {
    return { ok: false, errors: [{ path: ADAPTER_INPUT_ENV_VAR, reason: 'required env var is missing' }] };
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (error) {
    return {
      ok: false,
      errors: [{ path: ADAPTER_INPUT_ENV_VAR, reason: `not valid JSON: ${error instanceof Error ? error.message : String(error)}` }],
    };
  }
  const errors: ParseError[] = [];
  if (!isRecord(json)) {
    return { ok: false, errors: [{ path: '$', reason: 'expected an object' }] };
  }
  requireString(json, 'checkout_path', 'checkout_path', errors);
  requireString(json, 'case_file_path', 'case_file_path', errors);
  requireString(json, 'prompt_path', 'prompt_path', errors);
  const modelConfig = json['model_config'];
  if (!isRecord(modelConfig) || typeof modelConfig['model'] !== 'string') {
    errors.push({ path: 'model_config.model', reason: 'expected a string' });
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, input: json as unknown as AdapterInput };
};

const definedEnv = (env: EnvMap): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
};

export const runAdapterCli = async (
  env: EnvMap,
  deps: ClaudeCodeDeps,
  io: AdapterCliIo,
): Promise<number> => {
  const parsed = parseAdapterInput(env[ADAPTER_INPUT_ENV_VAR]);
  if (!parsed.ok) {
    io.stderr(JSON.stringify({ kind: 'invalid_adapter_input', errors: parsed.errors }));
    return 1;
  }
  const outcome = await runClaudeCodeAdapter(
    {
      input: parsed.input,
      promptPath: parsed.input.prompt_path,
      timeoutMs: DEFAULT_CLI_TIMEOUT_MS,
      env: definedEnv(env),
    },
    deps,
  );
  if (outcome.kind === 'ok') {
    io.stdout(JSON.stringify(outcome.result));
    return 0;
  }
  io.stderr(JSON.stringify(outcome));
  return 1;
};

const isDirectInvocation = (argv1: string | undefined): boolean =>
  argv1 !== undefined && import.meta.url === pathToFileURL(argv1).href;

if (isDirectInvocation(process.argv[1])) {
  const deps: ClaudeCodeDeps = {
    runner: createCommandRunner(),
    reader: createFileReader(),
    writer: createFileWriter(),
  };
  runAdapterCli(
    process.env,
    deps,
    {
      stdout: (line) => process.stdout.write(`${line}\n`),
      stderr: (line) => process.stderr.write(`${line}\n`),
    },
  )
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
