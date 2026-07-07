import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createRecordingGitHub } from '../../tests/helpers/github-fake.js';
import {
  bindCaseFileToRepo,
  createPipelineHarness,
  loadFixtureCaseFile,
  PIPELINE_RUN_LINKS,
} from '../../tests/helpers/pipeline-harness.js';
import type { PipelineHarness } from '../../tests/helpers/pipeline-harness.js';
import { CANDIDATE_LABEL } from '../pr/open-pr.js';
import { createCommandRunner } from '../utils/exec.js';

const INTEGRATION_TIMEOUT = 30_000;

describe('fix -> verify -> publish pipeline (integration, in-process, no network)', () => {
  let harness: PipelineHarness;

  beforeEach(async () => {
    harness = await createPipelineHarness();
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  it(
    'happy-tier1 yields exactly one openPullRequest call passing the US-009 body checklist with the candidate label',
    { timeout: INTEGRATION_TIMEOUT },
    async () => {
      const caseFile = bindCaseFileToRepo(
        await loadFixtureCaseFile('node-api-500.json'),
        harness.repo,
      );
      const fixBundle = await harness.runFix('happy-tier1', caseFile);

      expect(fixBundle.fixDiff).toContain('src/total.js');
      expect(Object.keys(fixBundle.artifactFiles)).toEqual([harness.repo.artifactPath]);

      const verifyBundle = await harness.runVerify(caseFile, fixBundle, createCommandRunner());
      expect(verifyBundle.verdict.kind).toBe('counterfactual');

      await harness.resetToFreshCheckout();
      const github = createRecordingGitHub();
      const publishResult = await harness.runPublish(caseFile, fixBundle, verifyBundle, github);

      expect(publishResult.kind).toBe('published');
      expect(github.pullRequests).toHaveLength(1);
      expect(github.branchPushes).toHaveLength(1);
      expect(github.branchPushes[0]?.branch).toBe('amends/fix-happy-tier1');

      const body = github.pullRequests[0]?.body ?? '';
      expect(body).toContain('## Case-file summary');
      expect(body).toContain(caseFile.work_item.id);
      expect(body).toContain(harness.repo.artifactPath);
      expect(body).toContain(PIPELINE_RUN_LINKS.originalRun);
      expect(body).toContain(PIPELINE_RUN_LINKS.patchedRun);
      expect(body).toContain('Tier 1');
      expect(body).toContain('fixture_only_data_path');
      expect(body).toContain('fake-adapter');
      expect(body).toContain('fake-model');
      expect(body).toContain('## Autonomy downgrade');
      expect(body).not.toMatch(/proven/i);

      const prNumber = github.pullRequests.length > 0 ? 101 : 0;
      expect(github.labels).toContainEqual({ issueNumber: prNumber, label: CANDIDATE_LABEL });

      const patchedFile = await readFile(join(harness.repo.repoPath, 'src/total.js'), 'utf8');
      expect(patchedFile).toContain('item.quantity');
    },
  );
});
