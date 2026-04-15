import babel from '@rolldown/plugin-babel';
import { defineConfig } from 'vitest/config';

function decoratorPreset(options: Record<string, unknown>): Record<string, unknown> {
  return {
    preset: () => ({
      plugins: [['@babel/plugin-proposal-decorators', options]],
    }),
    rolldown: {
      filter: {
        code: '@',
      },
    },
  };
}

export default defineConfig({
  oxc: {
    target: 'es2023',
  },
  plugins: [babel({ presets: [decoratorPreset({ version: '2023-11' })] })],
  test: {
    maxWorkers: 1,
    testTimeout: 10 * 60_000,
  },
});
