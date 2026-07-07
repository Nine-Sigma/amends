import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Anchor to the workspace root so per-package scripts can reuse this config via --config.
  root: import.meta.dirname,
  test: {
    include: ['{schema,sdk,cli,relay,action}/**/src/**/*.test.ts'],
    passWithNoTests: true,
  },
});
