import { defineConfig } from 'vitest/config';

export default defineConfig({
  esbuild: {
    format: 'esm',
    platform: 'node',
    target: 'es2023',
    tsconfigRaw: {
      compilerOptions: {
        experimentalDecorators: true,
        target: 'ES2023',
        useDefineForClassFields: false,
      },
    },
  },
  test: {
    maxWorkers: 1,
    testTimeout: 10 * 60_000,
  },
});
