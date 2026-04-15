import { defineConfig } from 'vitest/config';

export default defineConfig({
  esbuild: {
    format: 'esm',
    target: 'es2023',
    tsconfigRaw: JSON.stringify({
      compilerOptions: {
        experimentalDecorators: true,
        useDefineForClassFields: false,
      },
    }),
  },
  test: {
    maxWorkers: 1,
    testTimeout: 10 * 60_000,
  },
});
