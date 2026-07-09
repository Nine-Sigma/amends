import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';

const CONTAINMENT_PROBE_ROOT = resolve(sep, 'amends-containment-probe');

/**
 * Resolve-based containment for untrusted repo-relative paths (§8.1):
 * collapses `a/../../b` and rejects absolute paths, which a lexical `..` scan
 * misses. Purely lexical — it cannot stop a symlink escape (a checked-out
 * `link -> /etc` plus `link/passwd` passes); accepted Phase 1 residual, see
 * docs/remediation-phase-1.md §0.2.
 */
export const isCheckoutContainedPath = (path: string): boolean => {
  const target = resolve(CONTAINMENT_PROBE_ROOT, path);
  return target === CONTAINMENT_PROBE_ROOT || target.startsWith(CONTAINMENT_PROBE_ROOT + sep);
};

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

/** Injected file-read boundary; an unreadable path rejects — callers that need it structured catch at their boundary. */
export interface FileReader {
  read(absolutePath: string): Promise<string>;
}

export const createFileReader = (): FileReader => ({
  read: (absolutePath) => readFile(absolutePath, 'utf8'),
});
