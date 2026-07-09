/**
 * Layer-A agent adapter contract (product PRD §3.4). These types mirror the
 * adapter wire format (snake_case): the documented spec community adapters
 * conform to. Adapter output is untrusted input — it is parsed from unknown
 * in run-adapter.ts, never trusted typed.
 */

/**
 * What the fix stage hands an adapter before spawning it. Delivered to the
 * child serialized as JSON in the AMENDS_ADAPTER_INPUT env var (run-adapter.ts).
 */
export interface AdapterInput {
  /** Absolute path to the repo checkout at the resolved revision. */
  checkout_path: string;
  /** Absolute path to the case file the adapter must work from. */
  case_file_path: string;
  /** Absolute path to the assembled fix-pass prompt — outside the checkout (1.4). */
  prompt_path: string;
  model_config: ModelConfig;
}

/**
 * Model backend selection (Layer B, §3.4). Open shape: adapters route
 * inference themselves, so backend-specific keys (base_url, provider auth
 * hints, ...) pass through unmodeled.
 */
export interface ModelConfig {
  model: string;
  [key: string]: unknown;
}

/**
 * Cost-reporting contract (§3.4): required on every adapter result. Honesty
 * rule — an adapter that cannot report usage says so via usage_source
 * 'unavailable' with null figures; that is conformant and preserved.
 */
export interface UsageBlock {
  input_tokens: number | null;
  output_tokens: number | null;
  estimated_usd: number | null;
  usage_source: UsageSource;
  [key: string]: unknown;
}

export type UsageSource = 'reported' | 'estimated' | 'unavailable';

/** The narrowed body of an adapter's result JSON (exit code is observed by the runner, never self-reported). */
export interface AdapterResultBody {
  /** Branch ref the adapter committed its work to (or a symbolic diff ref). */
  branch_ref: string;
  /** Path to the fix diff as a unified patch — kept separable from the artifacts. */
  fix_diff_path: string;
  /**
   * Declared counterfactual artifact paths (repo-relative test files). MUST be
   * separable from the fix diff: the verify stage applies artifacts alone to
   * the original revision. Empty means no artifact (Tier 0 downstream).
   */
  artifact_paths: string[];
  usage: UsageBlock;
  [key: string]: unknown;
}

/** A conformant adapter result. Exit-code semantics live in run-adapter.ts outcomes; a self-reported exit_code field is never trusted. */
export type AdapterResult = AdapterResultBody;
