import { describe, expect, it } from 'vitest';

import { readActionInputs } from './index.js';

const fixEnv = (): Record<string, string | undefined> => ({
  GITHUB_WORKSPACE: '/work/checkout',
  INPUT_STAGE: 'fix',
  'INPUT_CASE-FILE': 'case-files/node-api-500.json',
  'INPUT_ADAPTER-COMMAND': 'fake-adapter',
  INPUT_MODEL: 'fake-model',
});

describe('readActionInputs', () => {
  it('accepts a fix-stage env and resolves paths against the workspace with defaults applied', () => {
    const result = readActionInputs(fixEnv());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.inputs.stage).toBe('fix');
      expect(result.inputs.caseFilePath).toBe('/work/checkout/case-files/node-api-500.json');
      expect(result.inputs.configPath).toBe('/work/checkout/amends.yml');
      expect(result.inputs.fixBundlePath).toBe('/work/checkout/amends-out/fix-bundle.json');
      expect(result.inputs.verifyBundlePath).toBe('/work/checkout/amends-out/verify-bundle.json');
      expect(result.inputs.promptPath).toBe('/work/checkout/amends-out/prompt.md');
      expect(result.inputs.base).toBe('main');
      expect(result.inputs.timeoutMs).toBe(600_000);
      expect(result.inputs.checkoutPath).toBe('/work/checkout');
    }
  });

  it('rejects a missing stage with a structured error naming the input', () => {
    const env = fixEnv();
    delete env['INPUT_STAGE'];
    const result = readActionInputs(env);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContainEqual({
        path: 'stage',
        reason: "expected one of 'fix' | 'verify' | 'publish'",
      });
    }
  });

  it('rejects an unknown stage value, never falls back', () => {
    const result = readActionInputs({ ...fixEnv(), INPUT_STAGE: 'compile' });
    expect(result.ok).toBe(false);
  });

  it('rejects a missing GITHUB_WORKSPACE', () => {
    const env = fixEnv();
    delete env['GITHUB_WORKSPACE'];
    const result = readActionInputs(env);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.map((error) => error.path)).toContain('GITHUB_WORKSPACE');
    }
  });

  it('requires adapter-command and model only for the fix stage', () => {
    const env = fixEnv();
    delete env['INPUT_ADAPTER-COMMAND'];
    delete env['INPUT_MODEL'];
    const fixResult = readActionInputs(env);
    expect(fixResult.ok).toBe(false);
    if (!fixResult.ok) {
      const paths = fixResult.errors.map((error) => error.path);
      expect(paths).toContain('adapter-command');
      expect(paths).toContain('model');
    }

    const verifyResult = readActionInputs({ ...env, INPUT_STAGE: 'verify' });
    expect(verifyResult.ok).toBe(true);
  });

  it('parses adapter-secret-env as a comma-separated allowlist, defaulting empty', () => {
    const withSecrets = readActionInputs({
      ...fixEnv(),
      'INPUT_ADAPTER-SECRET-ENV': 'ANTHROPIC_API_KEY, CLAUDE_CODE_OAUTH_TOKEN',
    });
    expect(withSecrets.ok).toBe(true);
    if (withSecrets.ok) {
      expect(withSecrets.inputs.adapterSecretEnv).toEqual([
        'ANTHROPIC_API_KEY',
        'CLAUDE_CODE_OAUTH_TOKEN',
      ]);
    }

    const without = readActionInputs(fixEnv());
    expect(without.ok).toBe(true);
    if (without.ok) {
      expect(without.inputs.adapterSecretEnv).toEqual([]);
    }
  });

  it('rejects a non-numeric timeout-ms', () => {
    const result = readActionInputs({ ...fixEnv(), 'INPUT_TIMEOUT-MS': 'soon' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.map((error) => error.path)).toContain('timeout-ms');
    }
  });
});
