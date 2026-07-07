/**
 * Prompt assembly for the fix pass (§8.1): every case-file-derived string is
 * rendered only inside delimited, labeled untrusted blocks. Case-file text
 * containing a delimiter sequence fails assembly structured — escaping is
 * refused in favor of total rejection, so breakout is impossible by
 * construction.
 */

import type { CaseFile } from '../case-file/types.js';
import type { ParseError } from '../utils/narrow.js';

export const UNTRUSTED_OPEN_PREFIX = '<<<UNTRUSTED_DATA';
export const UNTRUSTED_CLOSE = '<<<END_UNTRUSTED_DATA>>>';
export const UNTRUSTED_BLOCKS_PLACEHOLDER = '{{untrusted_case_file_blocks}}';

/** Checked case-insensitively: a visually plausible delimiter is as dangerous as an exact one. */
const DELIMITER_SEQUENCES = ['<<<untrusted_data', '<<<end_untrusted_data'] as const;

export type AssembleResult =
  | { ok: true; prompt: string }
  | { ok: false; errors: ParseError[] };

const checkString = (value: string, path: string, errors: ParseError[]): void => {
  const lowered = value.toLowerCase();
  for (const sequence of DELIMITER_SEQUENCES) {
    if (lowered.includes(sequence)) {
      errors.push({
        path,
        reason: `case-file text contains the untrusted-block delimiter sequence '${sequence}'`,
      });
      return;
    }
  }
};

const collectDelimiterCollisions = (value: unknown, path: string, errors: ParseError[]): void => {
  if (typeof value === 'string') {
    checkString(value, path, errors);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => {
      collectDelimiterCollisions(entry, `${path}.${index}`, errors);
    });
    return;
  }
  if (typeof value === 'object' && value !== null) {
    for (const [key, entry] of Object.entries(value)) {
      const entryPath = path === '$' ? key : `${path}.${key}`;
      checkString(key, entryPath, errors);
      collectDelimiterCollisions(entry, entryPath, errors);
    }
  }
};

export const assemblePrompt = (caseFile: CaseFile, template: string): AssembleResult => {
  const errors: ParseError[] = [];
  if (!template.includes(UNTRUSTED_BLOCKS_PLACEHOLDER)) {
    errors.push({
      path: 'template',
      reason: `template is missing the ${UNTRUSTED_BLOCKS_PLACEHOLDER} placeholder`,
    });
  }
  collectDelimiterCollisions(caseFile, '$', errors);
  if (errors.length > 0) {
    return { ok: false, errors };
  }
  const block = [
    `${UNTRUSTED_OPEN_PREFIX} channel="case_file">>>`,
    JSON.stringify(caseFile, null, 2),
    UNTRUSTED_CLOSE,
  ].join('\n');
  return { ok: true, prompt: template.replace(UNTRUSTED_BLOCKS_PLACEHOLDER, () => block) };
};
