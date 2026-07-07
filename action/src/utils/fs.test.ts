import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createFileReader, createFileWriter } from './fs.js';

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

describe('createFileReader', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'amends-fs-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('reads a written file back', async () => {
    const target = join(dir, 'bundle.json');
    await createFileWriter().write(target, '{"ok":true}');

    expect(await createFileReader().read(target)).toBe('{"ok":true}');
  });

  it('rejects on a missing file (environment fault, not structured)', async () => {
    await expect(createFileReader().read(join(dir, 'absent.json'))).rejects.toThrow();
  });
});
