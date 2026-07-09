import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadFixtureCaseFile } from '../../tests/helpers/pipeline-harness.js';
import { defaultConfig } from '../../tests/helpers/pipeline-harness.js';
import type { CommandRunner } from '../utils/exec.js';
import { createFileWriter } from '../utils/fs.js';
import type { FixBundle } from './bundle.js';
import { parseVerifyBundle } from './bundle.js';
import { runVerifyStage } from './verify.js';

const refusingRunner: CommandRunner = {
  run: () => Promise.reject(new Error('verify must refuse before any command runs')),
};

const fixBundleWith = (artifactFiles: Record<string, string>): FixBundle => ({
  fixDiff: '',
  artifactFiles,
  adapterResult: {
    branch_ref: 'amends/fix-x',
    fix_diff_path: 'amends-out/fix.patch',
    artifact_paths: Object.keys(artifactFiles),
    usage: { input_tokens: null, output_tokens: null, estimated_usd: null, usage_source: 'unavailable' },
  },
  agentIdentity: { agent: 'fake-adapter', model: 'fake-model' },
});

describe('runVerifyStage pre-run gates', () => {
  let outDir: string;

  beforeEach(async () => {
    outDir = await mkdtemp(join(tmpdir(), 'amends-verify-stage-'));
  });

  afterEach(async () => {
    await rm(outDir, { recursive: true, force: true });
  });

  const requestFor = async (fixtureName: string, artifactFiles: Record<string, string>) => ({
    caseFile: await loadFixtureCaseFile(fixtureName),
    fixBundle: fixBundleWith(artifactFiles),
    repoPath: '/unused/repo',
    env: {},
    timeoutMs: 1_000,
    config: defaultConfig(),
    bundlePath: join(outDir, 'verify-bundle.json'),
  });

  it('an unresolved release refuses before any command and serializes the verdict bundle', async () => {
    const request = await requestFor('node-api-500-unresolved.json', { 'artifact.test.mjs': '// a' });

    const bundle = await runVerifyStage(request, { runner: refusingRunner, files: createFileWriter() });

    expect(bundle.verdict.kind).toBe('release_unresolved');
    const written = parseVerifyBundle(
      JSON.parse(await readFile(request.bundlePath, 'utf8')),
    );
    expect(written.ok).toBe(true);
    if (written.ok) {
      expect(written.bundle.verdict.kind).toBe('release_unresolved');
    }
  });

  it('a missing counterfactual artifact is evidence_gate_unmet naming what was absent', async () => {
    const request = await requestFor('node-api-500.json', {});

    const bundle = await runVerifyStage(request, { runner: refusingRunner, files: createFileWriter() });

    expect(bundle.verdict).toEqual({
      kind: 'evidence_gate_unmet',
      missing: ['counterfactual_artifact'],
    });
  });

  it('a case file without validation.test_command is evidence_gate_unmet', async () => {
    const request = await requestFor('node-api-500.json', { 'artifact.test.mjs': '// a' });
    const caseFile = {
      ...request.caseFile,
      validation: {},
    };

    const bundle = await runVerifyStage(
      { ...request, caseFile },
      { runner: refusingRunner, files: createFileWriter() },
    );

    expect(bundle.verdict).toEqual({
      kind: 'evidence_gate_unmet',
      missing: ['validation.test_command'],
    });
  });
});
