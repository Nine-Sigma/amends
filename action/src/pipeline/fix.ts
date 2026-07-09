/**
 * FIX sub-stage: assemble the prompt (untrusted blocks, US-007), run the
 * adapter, and serialize the handoff bundle for the verify job. Adapter
 * output is untrusted (§8.1): declared paths are checked against the
 * checkout boundary before any read.
 */

import { isAbsolute, join } from 'node:path';

import type { AdapterInvocation, RunAdapterOutcome } from '../adapter/run-adapter.js';
import { runAdapter } from '../adapter/run-adapter.js';
import type { CaseFile } from '../case-file/types.js';
import { assemblePrompt } from '../prompt/assemble.js';
import type { CommandRunner } from '../utils/exec.js';
import { isCheckoutContainedPath } from '../utils/fs.js';
import type { FileReader, FileWriter } from '../utils/fs.js';
import type { ParseError } from '../utils/narrow.js';
import type { FixBundle } from './bundle.js';

export interface FixStageRequest {
  caseFile: CaseFile;
  invocation: AdapterInvocation;
  promptTemplate: string;
  /** Where the assembled prompt is written for the adapter to read. */
  promptPath: string;
  /** Declared handoff path for the serialized FixBundle. */
  bundlePath: string;
}

export interface FixStageDeps {
  runner: CommandRunner;
  files: FileWriter;
  reader: FileReader;
}

export type AdapterFailure = Exclude<RunAdapterOutcome, { kind: 'ok' }>;

export type FixStageResult =
  | { kind: 'fix_complete'; bundle: FixBundle }
  | { kind: 'prompt_rejected'; errors: ParseError[] }
  | { kind: 'adapter_failed'; failure: AdapterFailure }
  | { kind: 'declared_path_rejected'; path: string; reason: string };

type DeclaredRead = { ok: true; content: string } | { ok: false; reason: string };

const readDeclared = async (
  reader: FileReader,
  checkoutPath: string,
  path: string,
): Promise<DeclaredRead> => {
  if (isAbsolute(path)) return { ok: false, reason: 'declared path must be repo-relative' };
  if (!isCheckoutContainedPath(path)) {
    return { ok: false, reason: 'declared path must not escape the checkout' };
  }
  try {
    return { ok: true, content: await reader.read(join(checkoutPath, path)) };
  } catch {
    return { ok: false, reason: 'declared file is unreadable' };
  }
};

export async function runFixStage(
  request: FixStageRequest,
  deps: FixStageDeps,
): Promise<FixStageResult> {
  const assembled = assemblePrompt(request.caseFile, request.promptTemplate);
  if (!assembled.ok) return { kind: 'prompt_rejected', errors: assembled.errors };
  await deps.files.write(request.promptPath, assembled.prompt);

  const outcome = await runAdapter(request.invocation, deps.runner);
  if (outcome.kind !== 'ok') return { kind: 'adapter_failed', failure: outcome };

  const checkoutPath = request.invocation.input.checkout_path;
  const diffRead = await readDeclared(deps.reader, checkoutPath, outcome.result.fix_diff_path);
  if (!diffRead.ok) {
    return { kind: 'declared_path_rejected', path: outcome.result.fix_diff_path, reason: diffRead.reason };
  }

  const artifactFiles: Record<string, string> = {};
  for (const path of outcome.result.artifact_paths) {
    const read = await readDeclared(deps.reader, checkoutPath, path);
    if (!read.ok) return { kind: 'declared_path_rejected', path, reason: read.reason };
    artifactFiles[path] = read.content;
  }

  const bundle: FixBundle = {
    fixDiff: diffRead.content,
    artifactFiles,
    adapterResult: outcome.result,
    agentIdentity: {
      agent: request.invocation.command,
      model: request.invocation.input.model_config.model,
    },
  };
  await deps.files.write(request.bundlePath, JSON.stringify(bundle, null, 2));
  return { kind: 'fix_complete', bundle };
}
