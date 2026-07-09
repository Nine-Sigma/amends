import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { build } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  bindCaseFileToRepo,
  loadFixtureCaseFile,
} from '../tests/helpers/pipeline-harness.js';
import { createTempGitRepo } from '../tests/helpers/temp-git.js';
import type { TempGitRepo } from '../tests/helpers/temp-git.js';

const execFileAsync = promisify(execFile);

const INTEGRATION_TIMEOUT = 60_000;

const packageRoot = resolve(import.meta.dirname, '..');

/** Mirrors the package build script — CJS deps inside the ESM bundle need a scoped require. */
const ESM_REQUIRE_BANNER =
  "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);";

/**
 * Executes the real bundles the action ships (action.yml runs.main /
 * package.json bin): proves the esbuild ESM bundle boots with its
 * dependencies inlined and that dist/index.js resolves prompts/fix-pass.md
 * through the `../prompts` hop that must survive bundling.
 */
describe('built dist bundles (packaging smoke)', () => {
  let stageRoot: string;
  let repo: TempGitRepo;

  beforeAll(async () => {
    // realpath: node resolves the script to its real path for import.meta.url,
    // and the bundles' direct-invocation guard compares it against argv[1].
    stageRoot = await realpath(await mkdtemp(join(tmpdir(), 'amends-dist-smoke-')));
    await Promise.all([
      build({
        entryPoints: [join(packageRoot, 'src/index.ts')],
        bundle: true,
        format: 'esm',
        platform: 'node',
        target: 'node22',
        outfile: join(stageRoot, 'dist/index.js'),
        banner: { js: ESM_REQUIRE_BANNER },
        logLevel: 'silent',
      }),
      build({
        entryPoints: [join(packageRoot, 'agents/cli.ts')],
        bundle: true,
        format: 'esm',
        platform: 'node',
        target: 'node22',
        outfile: join(stageRoot, 'dist/agents/cli.js'),
        banner: { js: ESM_REQUIRE_BANNER },
        logLevel: 'silent',
      }),
    ]);
    await mkdir(join(stageRoot, 'prompts'), { recursive: true });
    await copyFile(
      join(packageRoot, 'prompts/fix-pass.md'),
      join(stageRoot, 'prompts/fix-pass.md'),
    );
    repo = await createTempGitRepo();
    const caseFile = bindCaseFileToRepo(await loadFixtureCaseFile('node-api-500.json'), repo);
    await writeFile(join(repo.repoPath, 'case-file.json'), JSON.stringify(caseFile, null, 2));
  }, INTEGRATION_TIMEOUT);

  afterAll(async () => {
    await repo.cleanup();
    await rm(stageRoot, { recursive: true, force: true });
  });

  it(
    'dist/index.js runs the fix stage: inputs parse, prompt template resolves, repo checks out, adapter spawns',
    async () => {
      const runnerTemp = join(stageRoot, 'runner-temp');
      const result = await execFileAsync(
        'node',
        [join(stageRoot, 'dist/index.js')],
        {
          env: {
            PATH: process.env['PATH'] ?? '',
            GITHUB_WORKSPACE: repo.repoPath,
            RUNNER_TEMP: runnerTemp,
            INPUT_STAGE: 'fix',
            'INPUT_CASE-FILE': 'case-file.json',
            // `true` exits 0 with empty stdout: the pipeline must reach the
            // adapter and fail structurally on its output, not crash earlier.
            'INPUT_ADAPTER-COMMAND': 'true',
            INPUT_MODEL: 'claude-sonnet-5',
          },
        },
      ).catch((error: { code?: number; stdout: string; stderr: string }) => error);

      expect(result.stderr ?? '').toBe('');
      const output = JSON.parse(result.stdout) as { stage: string; kind: string; failure?: { kind: string } };
      expect(output.stage).toBe('fix');
      expect(output.kind).toBe('adapter_failed');
      expect(output.failure?.kind).toBe('malformed_json');
    },
    INTEGRATION_TIMEOUT,
  );

  it(
    'dist/agents/cli.js boots and reports a structured invalid_adapter_input without the transport env var',
    async () => {
      const result = await execFileAsync('node', [join(stageRoot, 'dist/agents/cli.js')], {
        env: { PATH: process.env['PATH'] ?? '' },
      }).catch((error: { code?: number; stdout: string; stderr: string }) => error);

      const outcome = JSON.parse(result.stderr) as { kind: string };
      expect(outcome.kind).toBe('invalid_adapter_input');
    },
    INTEGRATION_TIMEOUT,
  );
});
