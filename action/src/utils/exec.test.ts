import { describe, expect, it } from 'vitest';

import { createCommandRunner } from './exec.js';

const node = process.execPath;

describe('createCommandRunner', () => {
  it('captures stdout, stderr, and the exit code of a completed command', async () => {
    const runner = createCommandRunner();

    const result = await runner.run({
      command: node,
      args: ['-e', "console.log('out'); console.error('err'); process.exit(2);"],
      cwd: process.cwd(),
      env: {},
      timeoutMs: 10_000,
    });

    expect(result).toEqual({ kind: 'completed', exitCode: 2, stdout: 'out\n', stderr: 'err\n' });
  });

  it('kills the child and reports timed_out when the timeout elapses', async () => {
    const runner = createCommandRunner();

    const result = await runner.run({
      command: node,
      args: ['-e', 'setTimeout(() => {}, 60_000);'],
      cwd: process.cwd(),
      env: {},
      timeoutMs: 200,
    });

    expect(result).toEqual({ kind: 'timed_out', timeoutMs: 200 });
  });

  it('gives the child exactly the provided env map, nothing from the parent', async () => {
    const runner = createCommandRunner();

    const result = await runner.run({
      command: node,
      args: ['-e', 'console.log(JSON.stringify(Object.keys(process.env).sort()));'],
      cwd: process.cwd(),
      env: { AMENDS_ALLOWED: 'yes' },
      timeoutMs: 10_000,
    });

    if (result.kind !== 'completed') throw new Error('expected completed');
    const childEnvKeys = JSON.parse(result.stdout) as string[];
    expect(childEnvKeys).toContain('AMENDS_ALLOWED');
    expect(childEnvKeys).not.toContain('PATH');
    expect(childEnvKeys.every((key) => key === 'AMENDS_ALLOWED' || key.startsWith('__CF'))).toBe(
      true,
    );
  });

  it('rejects when the command cannot be spawned (environment fault, not adapter output)', async () => {
    const runner = createCommandRunner();

    await expect(
      runner.run({
        command: '/nonexistent/adapter-binary',
        args: [],
        cwd: process.cwd(),
        env: {},
        timeoutMs: 1_000,
      }),
    ).rejects.toThrow();
  });
});
