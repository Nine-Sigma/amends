# Remediation plan — Phase 1 `action/` package

## Context

The Ralph loop implemented Phase 1 of the `@amends/action` package (US-001…US-012). An adversarial review (9 finder angles + per-finding verification) found the offline-verifiable core solid and fully tested — but **the tests are green only because every integration path uses fakes** (fake GitHub client, fake adapter, and `temp-git.ts` which sets git identity that production never sets). Against a real GitHub-hosted runner the pipeline cannot complete, and three of the trust-boundary controls that are the product's reason to exist can be bypassed by untrusted case-file / adapter content.

12 issues were confirmed. This plan fixes all of them, plus the lower-severity quality items, in priority waves. Two of the issues (uncommitted `dist/`, missing adapter binary) are semi-acknowledged in code comments as deferred — they are included here because "fix all" was requested and the reference workflow cannot run without them.

*(2026-07-09: every diagnosis was independently re-verified against source by a second adversarial pass; all 12 confirmed real. That pass also found gaps in several of the proposed fixes — the sections below incorporate its amendments, including one non-bug explicitly recorded in 1.1 so it doesn't get "fixed".)*

---

## Wave 0 — Security / trust-boundary (must-fix; these defeat the guardrails)

### 0.1 Protected-path guardrail bypass — `action/src/verification/diff-paths.ts`
`parseFixDiffPaths` extracts guarded paths only from the `diff --git a/X b/Y` header. Three confirmed holes, worse than a header/`+++` mismatch:
- A **bare unified diff with no `diff --git` header at all** (which `git apply` accepts) matches nothing → empty path set → bypasses **all three** guardrails: protected paths, environment invariance, *and* the `max_files_changed` cap. Then `applyFixDiff` writes wherever the diff points.
- Git's **quoted-path form** (`diff --git "a/…" "b/…"`) never matches the regex — and `core.quotePath` is on by default, so this bites *honest* fixes too: any filename with a space/unicode emitted by the claude-code adapter's own `git diff --cached` silently escapes classification.
- Unquoted paths containing spaces split ambiguously on the greedy ` b/` regex.

Reproduced against real git: a diff headed `a/safe.js` with `+++ b/.github/workflows/evil.yml` passes the hard-block while writing the workflow file.

**Fix (deep, at altitude):** derive the touched paths from git itself instead of re-parsing the header. Add an async `enumerateFixDiffPaths(request, runner, files)` in `action/src/utils/apply-fix-diff.ts` (it already owns `PATCH_SCRATCH_PATH` + the runner) that runs `git apply --numstat -z <patch>` and parses the output — this is exactly the path list `git apply` will write. Guardrails then judge that list.
- **Parse the `--numstat -z` format precisely — it is itself a trap.** Regular entries are `added\tremoved\t<path>\0`; **renames/copies** emit `added\tremoved\t\0<oldpath>\0<newpath>\0` (empty path field, then two NUL-separated names — include *both*); **binary files** emit `-\t-\t<path>`. A naive "third field" parser mis-handles exactly the malicious-diff class this fix targets — cover all three forms in tests.
- **Residual hole to close or reject:** mode-change-only hunks (e.g. chmod on a hard-blocked path) emit *no* numstat line. Either reject diffs containing mode-only changes or additionally cross-check `git apply --summary` for `mode change` lines — do not leave it silent.
- Callers already have a runner: `runCounterfactual` (`counterfactual.ts:197`) and `runPublishStage` (`publish.ts:97`). Thread the enumerated paths in; **delete `parseFixDiffPaths` and `diff-paths.test.ts` outright** — no "thin sync fallback for display"; a dormant string parser with green tests invites a future caller to reintroduce the bypass. Write the new tests against `enumerateFixDiffPaths` instead, including the header-less, quoted-path, rename, binary, and mode-only cases.
- If `git apply --numstat` fails (diff doesn't apply / is malformed), treat it as a guardrail refusal, not "clear" — fail closed.

### 0.2 Artifact-key path traversal — `action/src/pipeline/bundle.ts:46`
`validateArtifactFiles` validates artifact *values* are strings but never the *keys*. The `..`/absolute guard lives only in `fix.ts:50` (`readDeclared`), which is bypassed on the verify/publish re-parse path. A bundle key `../../../etc/hook` reaches `join(repoPath, key)` + write in `writeArtifacts` (`counterfactual.ts:139`) and `materializeFix` (`publish.ts:71`).

**Fix:** add a shared `action/src/utils/fs.ts` helper and use it in `validateArtifactFiles` for every key (push a `ParseError` on violation) and in `readDeclared`. **Do not replicate `fix.ts:50-53`'s lexical check** (`split('/').includes('..')`) — use resolve-based containment instead: `const target = resolve(repoPath, key)` and require `target === repoRoot || target.startsWith(repoRoot + sep)` (with `repoRoot = resolve(repoPath)`), which correctly collapses `a/../../b` and absolute keys. Add bundle-parse tests for traversal keys (`../x`, `/abs`, `a/../../b`).
- **Known residual (document or fix at the sink):** a purely lexical/resolve check cannot stop a **symlink escape** — a checkout containing `link -> /etc` plus key `link/passwd` passes containment and writes outside the repo via `join(repoPath, key)`. Either note this as an accepted Phase 1 residual or harden the write sinks (`writeArtifacts`, `materializeFix`) with realpath-containment of the resolved parent before writing.

### 0.3 Tier escalation from claimed `test_command` — `action/src/tier/classify.ts:17,27`
`E2E_RUNNERS` name-matching grants Tier 2 (→ `automerge_eligible`) from the first token of the case file's free-text `validation.test_command`, while every real behavioral signal (`browserExercised`/`httpExercised`/`serverProcessSpawned`) is hardcoded `false` (`counterfactual.ts:163`). So `test_command: "playwright …"` earns auto-merge eligibility with zero observed evidence — violates PRD §7.1 ("classification keys on observable properties") and collapses the two-axis trust model. Threat framing, precisely: `test_command` is **repo-owner-authored** case-file data (§8.2), so this is "owner over-claims tier via a script name," not third-party escalation — still a real soundness break, because the tier design exists to keep *claims* from setting autonomy. Note the name-match is currently the *only* reachable path to Tier 2, and it's the unsound one.

**Fix:** remove the `E2E_RUNNERS` branch from `strongTier2Signals`. In Phase 1, Tier 2 must be reachable *only* through observed signals (`browserExercised`, `httpExercised && serverProcessSpawned`) — which are un-instrumented, so **Tier 2 becomes entirely unreachable until real instrumentation exists**; that is the intended, PRD-consistent conservative posture, stated here explicitly. Keep the `E2E_RUNNERS` set out entirely (don't leave dead config).
- **A load-bearing test breaks:** `classify.test.ts:72-79` ("classifies an integration/E2E runner as Tier 2") asserts `e2e_runner_exercised` appears in `reasons` — update it (the `browserExercised: true` fixture still classifies Tier 2 via `browser_context_exercised`; drop the removed reason).
- Add a test asserting a `playwright` runner with no observed signals classifies Tier 1, not Tier 2.

### 0.4 Full `process.env` forwarded to the fix adapter — `action/src/index.ts:182`
`dispatchFix` passes `definedEnv(env)` (the entire environment, no allowlist) to the adapter child, contradicting the field's documented contract (`run-adapter.ts:11`, `exec.ts:6`). Any job-level secret, `GITHUB_TOKEN`, and runner internals become readable by prompt-injected case-file content.

**Fix:** add `buildFixStageEnv(source, secretKeys)` next to `buildZeroSecretEnv` in `counterfactual.ts` (or a sibling `utils/env.ts`). Source the secret names from a new optional `adapter-secret-env` action input (comma-separated, e.g. `ANTHROPIC_API_KEY`) so the allowlist is explicit and configurable, not "whatever the runner has". Use it at `index.ts:182`. Add a test mirroring the existing zero-secret contract test.
- **The non-secret base must be broader than `PATH`+`HOME`** or it will starve a real adapter child: the claude CLI (and node generally) commonly needs `TMPDIR`/`TEMP`, `LANG`/`LC_*`, `XDG_*`, `SHELL`, `USER`. Define a `FIX_STAGE_ENV_ALLOWLIST` covering those non-secret basics; keep `GITHUB_TOKEN` **out** of the base (opt-in via `adapter-secret-env` only). The adapter does not need `GITHUB_WORKSPACE` — it receives `checkout_path` explicitly.
- Add an integration test that the claude-code adapter actually runs under the trimmed env (nothing covers that today — the leak has no test locking it in, but neither does the adapter's survival under an allowlist).

---

## Wave 1 — Runtime blockers (reference workflow cannot complete without these)

### 1.1 Publish crashes at `git commit` — `action/src/github/client.ts:110`
Commit runs under `buildZeroSecretEnv` (`{PATH, HOME}`) with no committer identity; hosted runners can't auto-detect → exit 128 → no PR. Only `temp-git.ts` sets identity, which is why tests miss it.

**Fix:** set an explicit bot identity on the commit. Cleanest without extra git calls: inject `GIT_AUTHOR_NAME`/`GIT_AUTHOR_EMAIL`/`GIT_COMMITTER_NAME`/`GIT_COMMITTER_EMAIL` (all four — commit fails with author-only) into the git env built in `dispatchPublish` (`index.ts:235`), *after* `buildZeroSecretEnv` — do not bake identity into `buildZeroSecretEnv` itself, which verify also uses. Default to `amends[bot]` / `amends[bot]@users.noreply.github.com`; make it overridable via optional `committer-name`/`committer-email` inputs — note that "overridable" means new `action.yml` inputs **plus** `readActionInputs`/`ActionInputs` plumbing (`index.ts:34-111`), not just the env injection. Add a client test asserting commit runs with identity env present.
- **Non-bug, do not "fix":** `git push` auth is *not* broken by the zero-secret env. `actions/checkout` persists the token in the local `.git/config` extraheader, which is cwd-scoped — push works with `{PATH, HOME}`. Never re-inject `GITHUB_TOKEN` into the git env; that would undermine the zero-secret boundary for nothing.

### 1.2 Verify crashes for any non-HEAD incident — `action/examples/amends-fix.yml`
Default `actions/checkout@v4` is shallow (`fetch-depth: 1`); `resetToOriginal` does `git checkout --force <release.revision>` (`counterfactual.ts:131`), and for a real incident the revision isn't the trigger HEAD → checkout fails, verify aborts with no verdict.

**Fix:** add `with: { fetch-depth: 0 }` to the checkout step in all three jobs (fix, verify, publish). Only the verify job strictly needs it *today*; fix and publish need it **because 1.7 lands** (both will check out `release.revision`) — the three are a package with 1.7, not independent hardening.
- **No runtime fallback fetch.** A `git fetch origin <revision>` retry inside `resetToOriginal` would run in the most locked-down job (`permissions: {}`, zero-secret env), and GitHub only serves *reachable* SHAs — if `fetch-depth: 0` didn't bring the revision in, the runtime fetch won't either. Keep the failure path fail-fast; the checkout-depth change is the deterministic fix. (Edge to note in docs: a `release.revision` unreachable from any ref — e.g. force-pushed away — cannot be verified at all.)

### 1.3 `git add --all` leaks handoff bundles into the PR — `action/src/github/client.ts:109`
Unscoped staging commits the downloaded `amends-out/{fix,verify}-bundle.json` (full adapter output, prompt, case-file content) onto the fix branch → PR ≠ validated diff, and raw content lands on a PR surface (PRD §9).

**Fix:** stage only the validated content. `createBranchAndPush` should accept the explicit path list (validated fix paths from 0.1's `enumerateFixDiffPaths` + `Object.keys(artifactFiles)`) and run `git add -- <paths>` instead of `--all`. `runPublishStage` already has both. Semantics check out: `git add -- <pathspec>` stages deletions of tracked files, and the enumerated paths include both rename sides, so deletes/renames are covered.
- **Plumbing, named:** this is a signature change through `OpenPrRequest` (`open-pr.ts:24-33`) → `BranchPushRequest` (`client.ts:10-13`) → the octokit client, plus the recording fake (`tests/helpers/github-fake.ts`) and its tests (`client.test.ts`, `open-pr.test.ts`). Bounded but not a one-liner — and it should land **before** 1.1 touches the same files (see sequencing).
- Belt-and-suspenders (cheap, do both): point the reference workflow's `download-artifact` steps at a path *outside* the checkout so the bundles never sit in the worktree at all.
- Add a client test asserting an unrelated untracked file is not staged.

### 1.4 Prompt file pollutes every fix diff — `action/agents/claude-code.ts:150` + `action/src/index.ts:102`
The fix stage writes the prompt (which embeds case-file content) to `amends-out/prompt.md` inside the checkout before the adapter runs; the adapter's `parsePorcelain` excludes only `.amends/`, so the prompt is swept into the diff by `git add -A` → `no_changes` unreachable, counts toward `max_files_changed`, committed into the PR.

**Fix:** kill the class, not just the default — a user-overridden `prompt-path` anywhere outside `.amends/` would pollute the diff all over again. Preferred: write the prompt to an **absolute path outside the worktree** (e.g. under `RUNNER_TEMP`); the adapter reads it by absolute path (`claude-code.ts:166`), so an out-of-tree prompt can never enter the diff regardless of user input. If keeping it in-tree instead, change the default to `.amends/prompt.md` (`action.yml:40` + `index.ts:102`, both places) **and** pass the repo-relative prompt path into `captureFixDiff` as an extra `:(exclude)` so overrides stay safe. Verify the fix-bundle default stays `amends-out/…` (written after the diff is captured, so it never pollutes). Nothing else reads the prompt file (the workflow uploads only `fix-bundle.json`), so relocation breaks nothing. Add an adapter test: prompt written + no edits ⇒ `no_changes`.

### 1.5 `dist/index.js` not committed / deps not bundled — `action/action.yml:62`, `action/package.json`
`runs.main: dist/index.js` is gitignored and never built into the tree; `src/index.ts:11` imports `@octokit/rest`/`yaml` unconditionally, which would `ERR_MODULE_NOT_FOUND` on a runner. `uses: amends/action@v0` cannot start.

**Fix (standard GitHub Action packaging, but pick the bundler for *this* codebase):**
- Use **esbuild, not ncc**: `esbuild src/index.ts --bundle --format=esm --platform=node --target=node22 --outfile=dist/index.js`. The package is `"type": "module"` / NodeNext with pure-ESM `@octokit/rest` v22 and uses `import.meta.dirname` (`index.ts:169`) and `import.meta.url` (`index.ts:285`) — exactly the constructs ncc's CJS-first pipeline historically mangles.
- The bundle still reads `prompts/fix-pass.md` relative to `import.meta.dirname` — `prompts/` must ship alongside `dist/` and the relative hop must survive bundling. Add a smoke test that executes the built `dist/index.js` and confirms it resolves the prompt file.
- Un-ignore `action/dist/` (add a negation in `.gitignore` or a scoped `action/.gitignore`) and commit the built bundle. Note in CONTRIBUTING/README that `dist` is a build artifact that must be rebuilt+committed on release (standard for JS actions).
- Add a CI check that `dist` is up to date (rebuild + `git diff --exit-code`). Note: **the repo has no `.github/workflows/` at all today** — this is a greenfield CI workflow, not an edit.

### 1.6 Adapter invocation transport + missing CLI binary — `action/examples/amends-fix.yml:35`, `action/agents/claude-code.ts`, `action/src/adapter/run-adapter.ts` (absorbs 2.2)
`adapter-command: claude-code-adapter` names an executable with no CLI entry, no `bin`, and `agents/` excluded from the build (`tsconfig.build.json` includes only `src`). Spawn-ENOENT rejects in `exec.ts:52-55` and is caught only by the top-level `main().catch()` (`index.ts:293`) — not an unhandled rejection, but an opaque exit-1 instead of a structured `adapter_failed` outcome.

The deeper design gap (this is why 2.2 folds in here): `run-adapter.ts:33-39` spawns with `stdio: ['ignore', …]` — **no stdin** — and never serializes `invocation.input` (`AdapterInput`: `checkout_path`, `case_file_path`, `model_config`) to the child. So `model_config.model` structurally *cannot* reach the adapter, and the reference workflow passes no `adapter-args` either. Any CLI built without deciding this first would start with an inconsistent contract.

**Fix — decide the transport once, then the CLI and docs follow:**
- Pick one delivery mechanism for `AdapterInput` (recommended: serialize it to JSON in a single env var, e.g. `AMENDS_ADAPTER_INPUT`, set by `runAdapter` — keeps argv clean and needs no stdin plumbing; argv via `adapter-args` remains the user escape hatch). Update `run-adapter.ts` and `agents/README.md` to state the contract.
- Add `action/agents/cli.ts`: a `#!/usr/bin/env node` shebang wrapper that reads the invocation via the chosen transport, calls `runClaudeCodeAdapter`, writes the result JSON to stdout, non-zero exit on failure.
- Add a `bin` entry (`"claude-code-adapter": "./dist/agents/cli.js"`) to `action/package.json`, include `agents/` in the build (tsconfig.build or the 1.5 esbuild step), and ensure the reference workflow installs it (an `npm i -g` / `npx` step, or reference the built path).
- Map spawn-ENOENT in `run-adapter.ts` to a structured `adapter_failed` outcome regardless, so a misconfigured `adapter-command` fails with a typed result rather than an opaque exit-1.
- Then fix `action.yml:48`'s `model` description to match reality (see 2.2).

### 1.7 Fix diff generated against the wrong base — `action/src/index.ts:167` (fix stage)
The fix job runs the adapter against the trigger HEAD, but verify applies the diff onto `release.revision` and publish onto a fresh checkout → three potentially different bases; a correct fix can be misreported `fix_insufficient` / `fix_diff_apply_failed`.

**Fix:** centralize base selection in the action — **and it must cover publish, not just fix.** Extract `resetToOriginal` into a shared `checkoutRevision(runner, repoPath, revision, env)` helper and call it in all three stages:
- `dispatchFix`: check out `caseFile.release.revision` before running the adapter (detached HEAD is fine — the adapter only does `git add -A`/`git diff --cached`).
- Verify: already does this (`resetToOriginal`); just swap to the shared helper.
- **Publish**: `materializeFix` currently applies the diff onto the job's trigger-HEAD checkout and `createBranchAndPush` cuts the branch from that HEAD (`git checkout -b` from current HEAD) — the `publish.ts:6` comment claiming the tree is "at the original revision" is false today, and `publish.ts:68`'s "environment fault" throw fires on real drift. Check out `release.revision` before `materializeFix`.
- **Guard the unresolved case in the helper**: `release.revision` is `string | null` (null when `resolution.status === 'unresolved'`). Verify already returns `{ kind: 'release_unresolved' }` (`verify.ts:49-51`, with a passing integration test); fix and publish must reuse that structured outcome, not `git checkout null`.
- **Explicit decision needed:** branching from `release.revision` means the PR head can trail `base` by however far HEAD has moved — the PR diff vs base will show that drift. Accept it for Phase 1 (the diff is validated against `release.revision`; that's the honest base) and document it in the PR body, rather than rebasing (which would invalidate the verification).
- Requires the fetch-depth fix (1.2) so the revision is present in all three jobs.

---

## Wave 2 — Correctness / semantics

### 2.1 `issue_only` posts to a coincidentally-numbered issue — `action/src/pr/open-pr.ts:52`
Gates on `work_item.id` matching `/^\d+$/`, never on `work_item.kind` (open registry). `kind: "jira_ticket", id: "1301"` posts the fix comment onto unrelated GitHub issue #1301.

**Fix:** in `commentOnWorkItem`, first require `request.workItem.kind === 'github_issue'` (return `invalid_work_item` otherwise — the result variant already exists), then the numeric-id parse as a secondary integrity check. Add a test for a non-`github_issue` kind. `kind` is an open registry, so equality on the conventional value is deliberately fail-closed — future GitHub-ish kinds must be added explicitly. Nearby, same smell: `prTitle` (`publish.ts:76-77`) interpolates untrusted `work_item.kind`/`id` into the PR title unguarded — not exploitable like the comment path, but worth capping/sanitizing while here.

### 2.2 `action.yml` `model` description is inaccurate — `action/action.yml:48` (folded into 1.6)
Says `model` is "passed to the adapter as `model_config.model`," which never reaches the spawned process (`run-adapter.ts` never serializes `AdapterInput` — see 1.6); it only lands in PR-body/audit metadata (`fix.ts:91` → `compose-body.ts:79`). This is the same design gap as the missing CLI, so the fix lands as the last bullet of 1.6: once the invocation transport delivers `model_config`, the description becomes true — write it to match whatever transport 1.6 chooses.

---

## Wave 3 — Quality (conventions, reuse, efficiency, simplification)

These are lower severity; batch after the bug waves. Grouped, not itemized per line:

- **Missing colocated tests (CLAUDE.md hard rule).** Add `narrow.test.ts`, `apply-fix-diff.test.ts`, `parse-result.test.ts`, and `pipeline/{fix,verify,publish}.test.ts`. These are the trust-boundary narrowers and stage entry points — several Wave 0/1 fixes above already require new tests here, so land them together.
- **Reuse.** Extract the 3× copy-pasted "run git or throw" wrapper (`github/client.ts:89`, `counterfactual.ts:115`, `claude-code.ts:122` — the harness's `gitRun` at `pipeline-harness.ts:183` never checks the result, a different shape; leave it) into one `utils/git.ts` `runGitOrThrow`, parametrizing the void-vs-stdout return. Extract the triplicated fixture loader (`compose-body.test.ts`, `assemble.test.ts`, `pipeline-harness.ts`) to a single shared helper. Add a `requireOneOf` narrower for the 4× string-union membership checks (`bundle.ts`, `parse-result.ts`).
- **Efficiency.** `exec.ts` buffers subprocess stdout/stderr unboundedly via string concat — collect chunks in an array, join once, and cap retained output for the test-run path (only the adapter-JSON path needs full stdout). Parallelize the sequential bundle loads in `dispatchVerify`/`dispatchPublish` with `Promise.all`. Batch `open-pr.ts` labels into one `addLabels` call.
- **Simplification.** Remove dead `AdapterResult.exit_code` (constant-0, never read) and its bundle re-validation; drop the now-unreachable tier-signal validation for signals no producer emits (post-0.3). Collapse the `tierLevel === 0 || autonomy === 'diagnostic_only'` double-check (`publish.ts:92`) once autonomy carries the tier-0 narrowing.

---

## Recommended sequencing

1. **Wave 0** (security) first — 0.1 introduces `enumerateFixDiffPaths`, which 1.3 depends on.
2. **Wave 1** (blockers) — do **1.3 before 1.1**: 1.3 changes the `createBranchAndPush`/`BranchPushRequest` signatures and the recording fake; landing 1.1's env change after avoids double-editing the same files/tests. 1.7 extracts `checkoutRevision` and pairs with 1.2 (fetch-depth). 1.5/1.6 are the packaging pair; decide 1.6's invocation transport before writing the CLI, do them together, and test `uses: ./action` locally.
3. **Wave 2** (correctness) — 2.1 is small and independent; 2.2 rides along with 1.6.
4. **Wave 3** (quality) — fold the new tests from Waves 0–2 in here.

Each fix follows repo TDD: failing test first, then the change. Keep functions ≤60 lines / files ≤400 lines (extract into the owning module's `utils/`).

## Verification

- `pnpm --filter @amends/action test` — all existing 244 tests plus new ones green. Wave 0/1 tests must **fail before** the fix and pass after (they encode the bypass/crash).
- `pnpm typecheck && pnpm lint` clean across the repo.
- **End-to-end, the part fakes never exercised:** in a scratch git repo, run the built `dist/index.js` for real:
  - `stage: fix` against a hand-written case file with an incident `release.revision` ≠ HEAD → confirm the adapter runs at the incident revision and the fix diff excludes the prompt file.
  - `stage: verify` under a shallow-then-`fetch-depth:0` checkout → confirm it produces a verdict rather than crashing.
  - `stage: publish` with a real local git identity absent → confirm the injected bot identity lets `git commit` succeed and only validated paths are staged (`git show --stat` on the branch shows no `amends-out/`).
- **Adversarial regression checks:** feed a header-less bare unified diff, a `+++`-mismatched hard-blocked path, a quoted-path diff, a rename diff, and a mode-change-only diff → confirm guardrail refusal or correct enumeration for each (0.1); feed a bundle with `../`, absolute, and `a/../../b` artifact keys → confirm parse rejection (0.2); feed `test_command: "playwright"` with no observed signals → confirm Tier 1, not auto-merge-eligible (0.3).
- Rebuild `dist` and confirm `git diff --exit-code dist` is clean (1.5).
