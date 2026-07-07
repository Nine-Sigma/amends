import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['{schema,sdk,cli,relay,action}/**/src/**/*.test.ts'],
    passWithNoTests: true,
  },
});
