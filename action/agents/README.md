# Agent adapters

An adapter (Layer A, product PRD §3.4) turns one case file into a candidate fix inside a
repository checkout. The pipeline treats every adapter as an untrusted subprocess: it
spawns the adapter, narrows its stdout from unknown, and independently verifies whatever
the adapter claims. Conforming here makes an adapter usable by `@amends/action` without
touching the pipeline.

## Process contract

The fix stage spawns the adapter via the configured `adapter-command` + `adapter-args`
(see `action/action.yml`), with:

- **cwd**: the repository checkout at the resolved incident revision (`checkout_path`).
- **env**: an explicit, complete map — the child sees nothing beyond what the workflow
  passes. Model credentials are present only in the fix job (§8.1); the verify job runs
  agent-authored tests with zero secrets.
- **timeout**: the run is killed after `timeout-ms`; a killed run is a structured
  `timeout` failure, not a crash.

Anything the adapter needs beyond cwd/env (prompt path, case-file path, model) arrives
through `adapter-args`, chosen by the user's workflow.

## Inputs

- The **assembled prompt** (US-007): a file whose case-file-derived content sits inside
  `<<<UNTRUSTED_DATA ...>>>` blocks. The adapter must deliver it to the agent verbatim —
  never unwrap, reorder, or summarize the untrusted blocks.
- The **case file** path, if the adapter wants structured access; its content is
  untrusted input (§8.1).

## Output: result JSON on stdout

On success the adapter prints exactly one JSON object to stdout and exits 0. The parser
(`action/src/adapter/parse-result.ts`) is a tolerant reader: unknown extra keys are
preserved, but the required fields below must be present and well-typed or the run is
rejected as `nonconforming`.

```json
{
  "branch_ref": "amends/claude-code-fix",
  "fix_diff_path": ".amends/fix.diff",
  "artifact_paths": ["src/checkout/total.counterfactual.test.ts"],
  "usage": {
    "input_tokens": 3134,
    "output_tokens": 892,
    "estimated_usd": 0.31,
    "usage_source": "reported"
  }
}
```

- `branch_ref` — branch the work was committed to, or a symbolic ref
  (`/^[A-Za-z0-9][A-Za-z0-9._/-]*$/`; validated before use as a git ref).
- `fix_diff_path` — repo-relative path to the fix as a unified patch. Absolute paths and
  `..` segments are rejected before any read.
- `artifact_paths` — repo-relative counterfactual test files, **separable from the fix
  diff**: verification applies the artifacts alone to the original revision expecting
  FAIL, then artifacts + fix diff expecting PASS. An artifact entangled with the fix
  cannot be validated. Empty means no artifact — the run classifies Tier 0 and no PR
  path exists.
- `usage` — required on every result (FR-11).

Exit-code semantics: **0** means "result JSON on stdout is authoritative"; any nonzero
exit is a structured `nonzero_exit` failure and stdout is ignored. The pipeline records
the exit code itself — an `exit_code` field in the JSON is never trusted.

## Usage honesty rule

`usage_source` is the one closed registry in the contract: `reported` (figures come from
the model backend), `estimated` (adapter-computed approximation), or `unavailable`.
An adapter that cannot report usage says `"usage_source": "unavailable"` with `null`
figures — that is conformant and preserved. Never fabricate figures to look complete.

## What adapters must never do

- Touch hard-blocked paths (`.github/workflows/**`, `amends.yml`) or verification
  configuration (`tsconfig*.json`, `vitest.config.*`, CI workflows, toolchain pins).
  Guardrails refuse such diffs before any verification run.
- Self-report an evidence tier. Tier is classified only from what the verify stage
  observes (§7.2); claim keys in the result JSON are ignored structurally.
- Describe output as a "proven fix" — adapter-facing text follows the same language
  discipline: validated, evidence-backed.

## The claude-code adapter (`claude-code.ts`)

Drives the Claude Code CLI headless: `claude -p <prompt> --output-format json
--model <model> --dangerously-skip-permissions`, cwd = checkout. The prompt file is read
and passed as the `-p` argument (the runner has no stdin). The permission skip is scoped
to the disposable fix-job checkout, which holds no secrets beyond model credentials.

After the CLI run it derives the result mechanically — observed over claimed:

- changed paths from `git status --porcelain`, ignoring the `.amends/` scratch dir;
- artifacts = **new** files whose name contains `.counterfactual.test.` (the fix-pass
  prompt instructs the agent to write them as new, separable test files);
- fix diff = `git add -A` + `git diff --cached` excluding scratch dir and artifacts,
  written to `.amends/fix.diff`;
- usage from the CLI result JSON's `usage` block (`reported`), else `unavailable`.

Structured outcomes: `ok`, `agent_failed` (nonzero CLI exit), `agent_timed_out`,
`agent_reported_error` (CLI ran but reported failure, e.g. `error_max_turns`),
`nonconforming_output` (stdout not a JSON result object), `no_changes`.

Offline scope (US-012 skip rule): invocation construction, output mapping, and failure
taxonomy are covered by tests against recorded CLI output shapes in `fixtures/`.
Follow-up for a live environment: compile `agents/` into the shipped dist with a process
entry that wires real deps (`createCommandRunner`/`createFileReader`/`createFileWriter`),
prints the result JSON for `run-adapter.ts`, and verify end-to-end with model
credentials.
