import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // envDist.test.ts and spawn.killOnExit.sigterm.test.ts both exercise dist/. Build it once
    // here instead of per-file beforeAll hooks: vitest runs test files in parallel workers and
    // build-ts deletes dist/ before writing, so concurrent rebuilds make another worker's
    // dist import fail with ERR_MODULE_NOT_FOUND.
    globalSetup: './test/buildDist.ts',
  },
});
