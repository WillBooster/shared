import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Some packageJson tests resolve dependency versions over the network, which intermittently
    // exceeds vitest's default 5s timeout even on unmodified main.
    testTimeout: 60_000,
  },
});
