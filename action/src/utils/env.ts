/**
 * Fix-stage adapter env (§8.1): a broader base than the verify stage's
 * zero-secret env — a real adapter CLI needs temp dirs, locale, and shell
 * basics — but still allowlist-only. Secrets reach the child exclusively via
 * the explicit `adapter-secret-env` grant; GITHUB_TOKEN is never in the base.
 */

export const FIX_STAGE_ENV_ALLOWLIST: readonly string[] = [
  'PATH',
  'HOME',
  'TMPDIR',
  'TEMP',
  'TMP',
  'RUNNER_TEMP',
  'LANG',
  'SHELL',
  'USER',
  'LOGNAME',
  'TERM',
];

const FIX_STAGE_ENV_PREFIXES: readonly string[] = ['LC_', 'XDG_'];

export const buildFixStageEnv = (
  source: Readonly<Record<string, string | undefined>>,
  secretKeys: readonly string[],
): Record<string, string> => {
  const allowed = (key: string): boolean =>
    FIX_STAGE_ENV_ALLOWLIST.includes(key) ||
    FIX_STAGE_ENV_PREFIXES.some((prefix) => key.startsWith(prefix)) ||
    secretKeys.includes(key);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && allowed(key)) env[key] = value;
  }
  return env;
};
