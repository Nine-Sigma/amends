import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { parseCaseFile } from '../../src/case-file/parse.js';
import type { CaseFile } from '../../src/case-file/types.js';

/** The §5.1 example case files shipped with the schema package double as test fixtures. */
export const FIXTURES_DIR = resolve(import.meta.dirname, '../../../schema/examples');

export const loadFixtureCaseFileSync = (name: string): CaseFile => {
  const parsed = parseCaseFile(JSON.parse(readFileSync(join(FIXTURES_DIR, name), 'utf8')));
  if (!parsed.ok) throw new Error(`fixture ${name} must parse`);
  return parsed.caseFile;
};
