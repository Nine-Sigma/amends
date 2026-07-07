import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createFileWriter } from './fs.js';

describe('createFileWriter', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'amends-fs-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('writes a file, creating missing parent directories', async () => {
    const target = join(dir, 'deeply/nested/artifact.test.ts');

    await createFileWriter().write(target, 'content');

    expect(await readFile(target, 'utf8')).toBe('content');
  });

  it('overwrites an existing file', async () => {
    const target = join(dir, 'file.txt');
    const writer = createFileWriter();

    await writer.write(target, 'first');
    await writer.write(target, 'second');

    expect(await readFile(target, 'utf8')).toBe('second');
  });
});
