/* eslint-disable */

import swc from '@rollup/plugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  esbuild: false,
  plugins: [
    (swc as any)({
      jsc: {
        target: 'ES2023',
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
