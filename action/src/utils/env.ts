/**
 * Fix-stage adapter env (§8.1): a broader base than the verify stage's
 * zero-secret env — a real adapter CLI needs temp dirs, locale, and shell
 * basics — but still allowlist-only. Secrets reach the child exclusively via
 * the explicit `adapter-secret-env` grant; GITHUB_TOKEN is never in the base.
 */

export const ZERO_SECRET_ENV_ALLOWLIST: readonly string[] = ['PATH', 'HOME'];

/** The verify stage's env: agent-authored tests see nothing beyond this (§8.1). */
export const buildZeroSecretEnv = (
  source: Readonly<Record<string, string | undefined>>,
): Record<string, string> => {
  const env: Record<string, string> = {};
  for (const key of ZERO_SECRET_ENV_ALLOWLIST) {
    const value = source[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
};

export interface CommitIdentity {
  name: string;
  email: string;
}

export const DEFAULT_COMMIT_IDENTITY: CommitIdentity = {
  name: 'amends[bot]',
  email: 'amends[bot]@users.noreply.github.com',
};

/**
 * Publish-stage git env: zero-secret base plus an explicit committer identity
 * (hosted runners auto-detect none; author-only still fails `git commit`).
 * GITHUB_TOKEN stays out — `actions/checkout` persists push auth in the
 * checkout's .git/config, so re-injecting it would weaken the boundary for
 * nothing.
 */
export const buildPublishGitEnv = (
  source: Readonly<Record<string, string | undefined>>,
  identity: CommitIdentity,
): Record<string, string> => ({
  ...buildZeroSecretEnv(source),
  GIT_AUTHOR_NAME: identity.name,
  GIT_AUTHOR_EMAIL: identity.email,
  GIT_COMMITTER_NAME: identity.name,
  GIT_COMMITTER_EMAIL: identity.email,
});

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
