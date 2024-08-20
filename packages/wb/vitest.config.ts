import { defineConfig } from 'vitest/config';
import swc from '@rollup/plugin-swc';

export default defineConfig({
  esbuild: false,
  plugins: [
    (swc as any)({
      jsc: {
        target: 'es2022',
        parser: {
          syntax: 'typescript',
          decorators: true,
        },
        transform: {
          decoratorVersion: '2022-03',
        },
      },
    }),
  ],
  test: {
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
    testTimeout: 10 * 60_000,
  },
});
