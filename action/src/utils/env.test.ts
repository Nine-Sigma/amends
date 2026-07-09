import { describe, expect, it } from 'vitest';

import { buildFixStageEnv, FIX_STAGE_ENV_ALLOWLIST } from './env.js';

const hostileEnv = {
  PATH: '/usr/bin',
  HOME: '/home/runner',
  TMPDIR: '/tmp/runner',
  LANG: 'en_US.UTF-8',
  LC_ALL: 'en_US.UTF-8',
  XDG_CONFIG_HOME: '/home/runner/.config',
  SHELL: '/bin/zsh',
  USER: 'runner',
  GITHUB_TOKEN: 'hostile',
  AWS_SECRET_ACCESS_KEY: 'hostile',
  ANTHROPIC_API_KEY: 'model-secret',
  NODE_OPTIONS: '--require=evil',
  GITHUB_WORKSPACE: '/workspace',
  undefined_value: undefined,
};

describe('buildFixStageEnv', () => {
  it('keeps only the non-secret base allowlist when no secret keys are granted', () => {
    const env = buildFixStageEnv(hostileEnv, []);

    expect(Object.keys(env).sort()).toEqual([
      'HOME',
      'LANG',
      'LC_ALL',
      'PATH',
      'SHELL',
      'TMPDIR',
      'USER',
      'XDG_CONFIG_HOME',
    ]);
  });

  it('forwards explicitly granted secret keys and nothing else secret-like', () => {
    const env = buildFixStageEnv(hostileEnv, ['ANTHROPIC_API_KEY']);

    expect(env['ANTHROPIC_API_KEY']).toBe('model-secret');
    expect(env).not.toHaveProperty('GITHUB_TOKEN');
    expect(env).not.toHaveProperty('AWS_SECRET_ACCESS_KEY');
    expect(env).not.toHaveProperty('NODE_OPTIONS');
    expect(env).not.toHaveProperty('GITHUB_WORKSPACE');
  });

  it('never invents keys absent from the source env', () => {
    const env = buildFixStageEnv({ PATH: '/usr/bin' }, ['ANTHROPIC_API_KEY']);

    expect(env).toEqual({ PATH: '/usr/bin' });
  });

  it('keeps GITHUB_TOKEN out of the base allowlist so it is opt-in only', () => {
    expect(FIX_STAGE_ENV_ALLOWLIST).not.toContain('GITHUB_TOKEN');

    const optedIn = buildFixStageEnv(hostileEnv, ['GITHUB_TOKEN']);
    expect(optedIn['GITHUB_TOKEN']).toBe('hostile');
  });
});
