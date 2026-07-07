import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * Injected file-write boundary, same pattern as exec.ts: modules never touch
 * the filesystem ambiently; the entry point constructs this and passes it in.
 */
export interface FileWriter {
  write(absolutePath: string, content: string): Promise<void>;
}

export const createFileWriter = (): FileWriter => ({
  write: async (absolutePath, content) => {
    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, content, 'utf8');
  },
});
