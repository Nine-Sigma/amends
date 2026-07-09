#!/usr/bin/env node
import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);

// agents/cli.ts
import { pathToFileURL } from "node:url";

// src/utils/narrow.ts
var isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
var missingOr = (value, expected) => value === void 0 ? "required field is missing" : `expected ${expected}`;
var requireString = (parent, key, path, errors) => {
  if (typeof parent[key] !== "string") {
    errors.push({ path, reason: missingOr(parent[key], "a string") });
  }
};

// src/adapter/run-adapter.ts
var ADAPTER_INPUT_ENV_VAR = "AMENDS_ADAPTER_INPUT";

// src/utils/exec.ts
import { spawn } from "node:child_process";
var MAX_SIGNATURE_OUTPUT = 400;
var commandFailureSignature = (result) => {
  if (result.kind === "timed_out") return `timed_out after ${result.timeoutMs}ms`;
  const output = (result.stderr.trim() || result.stdout.trim()).slice(0, MAX_SIGNATURE_OUTPUT);
  return `exit ${result.exitCode}: ${output}`;
};
var createCommandRunner = () => ({
  run: (request) => new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(request.command, request.args, {
      cwd: request.cwd,
      env: request.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, request.timeoutMs);
    child.stdout.on("data", (chunk) => stdout += chunk.toString());
    child.stderr.on("data", (chunk) => stderr += chunk.toString());
    child.on("error", (error) => {
      clearTimeout(timer);
      rejectPromise(error);
    });
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      resolvePromise(
        timedOut ? { kind: "timed_out", timeoutMs: request.timeoutMs } : { kind: "completed", exitCode: exitCode ?? 1, stdout, stderr }
      );
    });
  })
});

// src/utils/fs.ts
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
var CONTAINMENT_PROBE_ROOT = resolve(sep, "amends-containment-probe");
var createFileWriter = () => ({
  write: async (absolutePath, content) => {
    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, content, "utf8");
  }
});
var createFileReader = () => ({
  read: (absolutePath) => readFile(absolutePath, "utf8")
});

// agents/claude-code.ts
import { join } from "node:path";
var CLAUDE_CLI_COMMAND = "claude";
var ADAPTER_SCRATCH_DIR = ".amends";
var FIX_DIFF_OUTPUT_PATH = ".amends/fix.diff";
var CLAUDE_CODE_BRANCH_REF = "amends/claude-code-fix";
var COUNTERFACTUAL_ARTIFACT_MARKER = ".counterfactual.test.";
var buildClaudeCliInvocation = (request, promptContent) => ({
  command: CLAUDE_CLI_COMMAND,
  args: [
    "-p",
    promptContent,
    "--output-format",
    "json",
    "--model",
    request.input.model_config.model,
    "--dangerously-skip-permissions"
  ],
  cwd: request.input.checkout_path,
  env: request.env,
  timeoutMs: request.timeoutMs
});
var extractUsage = (output) => {
  const usage = output["usage"];
  if (isRecord(usage) && typeof usage["input_tokens"] === "number" && typeof usage["output_tokens"] === "number") {
    return {
      input_tokens: usage["input_tokens"],
      output_tokens: usage["output_tokens"],
      estimated_usd: typeof output["total_cost_usd"] === "number" ? output["total_cost_usd"] : null,
      usage_source: "reported"
    };
  }
  return { input_tokens: null, output_tokens: null, estimated_usd: null, usage_source: "unavailable" };
};
var parseClaudeCliOutput = (stdout) => {
  let json;
  try {
    json = JSON.parse(stdout);
  } catch (error) {
    return { ok: false, errors: [{ path: "$", reason: `stdout is not valid JSON: ${error instanceof Error ? error.message : String(error)}` }] };
  }
  if (!isRecord(json)) {
    return { ok: false, errors: [{ path: "$", reason: "expected a result object" }] };
  }
  return { ok: true, output: json };
};
var claudeReportedError = (output) => {
  const subtype = typeof output["subtype"] === "string" ? output["subtype"] : void 0;
  if (output["is_error"] !== true && (subtype === void 0 || subtype === "success")) return void 0;
  const result = typeof output["result"] === "string" ? output["result"] : "";
  return `${subtype ?? "unknown error"}: ${result}`.trim();
};
var runGit = async (deps, request, args) => {
  const result = await deps.runner.run({
    command: "git",
    args,
    cwd: request.input.checkout_path,
    env: request.env,
    timeoutMs: request.timeoutMs
  });
  if (result.kind === "timed_out" || result.exitCode !== 0) {
    throw new Error(`git ${args[0] ?? ""} failed: ${commandFailureSignature(result)}`);
  }
  return result.stdout;
};
var parsePorcelain = (stdout) => stdout.split("\n").filter((line) => line.length > 3).map((line) => {
  const rawPath = line.slice(3);
  const renameTarget = rawPath.split(" -> ")[1];
  return { path: renameTarget ?? rawPath, untracked: line.startsWith("??") };
}).filter((change) => !change.path.startsWith(`${ADAPTER_SCRATCH_DIR}/`));
var captureFixDiff = async (deps, request, artifactPaths) => {
  await runGit(deps, request, ["add", "-A"]);
  const excludes = [ADAPTER_SCRATCH_DIR, ...artifactPaths].map((path) => `:(exclude)${path}`);
  return runGit(deps, request, ["diff", "--cached", "--", ".", ...excludes]);
};
var runClaudeCodeAdapter = async (request, deps) => {
  const promptContent = await deps.reader.read(request.promptPath);
  const claudeRun = await deps.runner.run(buildClaudeCliInvocation(request, promptContent));
  if (claudeRun.kind === "timed_out") return { kind: "agent_timed_out", timeoutMs: claudeRun.timeoutMs };
  if (claudeRun.exitCode !== 0) {
    return { kind: "agent_failed", exitCode: claudeRun.exitCode, stderr: claudeRun.stderr };
  }
  const parsed = parseClaudeCliOutput(claudeRun.stdout);
  if (!parsed.ok) return { kind: "nonconforming_output", errors: parsed.errors };
  const reportedError = claudeReportedError(parsed.output);
  if (reportedError !== void 0) return { kind: "agent_reported_error", detail: reportedError };
  const changes = parsePorcelain(await runGit(deps, request, ["status", "--porcelain"]));
  if (changes.length === 0) return { kind: "no_changes" };
  const artifactPaths = changes.filter((change) => change.untracked && change.path.includes(COUNTERFACTUAL_ARTIFACT_MARKER)).map((change) => change.path);
  const fixDiff = await captureFixDiff(deps, request, artifactPaths);
  await deps.writer.write(join(request.input.checkout_path, FIX_DIFF_OUTPUT_PATH), fixDiff);
  return {
    kind: "ok",
    result: {
      branch_ref: CLAUDE_CODE_BRANCH_REF,
      fix_diff_path: FIX_DIFF_OUTPUT_PATH,
      artifact_paths: artifactPaths,
      usage: extractUsage(parsed.output)
    }
  };
};

// agents/cli.ts
var DEFAULT_CLI_TIMEOUT_MS = 6e5;
var parseAdapterInput = (raw) => {
  if (raw === void 0 || raw === "") {
    return { ok: false, errors: [{ path: ADAPTER_INPUT_ENV_VAR, reason: "required env var is missing" }] };
  }
  let json;
  try {
    json = JSON.parse(raw);
  } catch (error) {
    return {
      ok: false,
      errors: [{ path: ADAPTER_INPUT_ENV_VAR, reason: `not valid JSON: ${error instanceof Error ? error.message : String(error)}` }]
    };
  }
  const errors = [];
  if (!isRecord(json)) {
    return { ok: false, errors: [{ path: "$", reason: "expected an object" }] };
  }
  requireString(json, "checkout_path", "checkout_path", errors);
  requireString(json, "case_file_path", "case_file_path", errors);
  requireString(json, "prompt_path", "prompt_path", errors);
  const modelConfig = json["model_config"];
  if (!isRecord(modelConfig) || typeof modelConfig["model"] !== "string") {
    errors.push({ path: "model_config.model", reason: "expected a string" });
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, input: json };
};
var definedEnv = (env) => {
  const out = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== void 0) out[key] = value;
  }
  return out;
};
var runAdapterCli = async (env, deps, io) => {
  const parsed = parseAdapterInput(env[ADAPTER_INPUT_ENV_VAR]);
  if (!parsed.ok) {
    io.stderr(JSON.stringify({ kind: "invalid_adapter_input", errors: parsed.errors }));
    return 1;
  }
  const outcome = await runClaudeCodeAdapter(
    {
      input: parsed.input,
      promptPath: parsed.input.prompt_path,
      timeoutMs: DEFAULT_CLI_TIMEOUT_MS,
      env: definedEnv(env)
    },
    deps
  );
  if (outcome.kind === "ok") {
    io.stdout(JSON.stringify(outcome.result));
    return 0;
  }
  io.stderr(JSON.stringify(outcome));
  return 1;
};
var isDirectInvocation = (argv1) => argv1 !== void 0 && import.meta.url === pathToFileURL(argv1).href;
if (isDirectInvocation(process.argv[1])) {
  const deps = {
    runner: createCommandRunner(),
    reader: createFileReader(),
    writer: createFileWriter()
  };
  runAdapterCli(
    process.env,
    deps,
    {
      stdout: (line) => process.stdout.write(`${line}
`),
      stderr: (line) => process.stderr.write(`${line}
`)
    }
  ).then((exitCode) => {
    process.exitCode = exitCode;
  }).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}
`);
    process.exitCode = 1;
  });
}
export {
  runAdapterCli
};
