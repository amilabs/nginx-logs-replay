import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/unit/**/*.test.ts'],
    coverage: {
      include: ['src/lib/**/*.ts'],
      exclude: ['src/lib/metrics.ts'],
    },
  },
});
