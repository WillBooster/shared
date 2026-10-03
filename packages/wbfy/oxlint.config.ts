// wbfy:start oxlint-base
import type { OxlintConfig } from 'oxlint';

import oxlintBaseConfig from '@willbooster/oxlint-config';

const oxlintResolvedConfig: OxlintConfig = structuredClone(oxlintBaseConfig);
delete oxlintResolvedConfig.options;
// wbfy:end oxlint-base

oxlintResolvedConfig.overrides = [
  ...(oxlintResolvedConfig.overrides ?? []),
  {
    files: ['src/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: ['child_process', 'node:child_process'].map((name) => ({
            name,
            message:
              'wbfy runs under Bun, whose synchronous spawns can hang (oven-sh/bun#34069). Spawn through spawnUtil.ts or spawnAsync of @willbooster/shared-lib-node.',
          })),
        },
      ],
    },
  },
];

// wbfy:start oxlint-export
export default oxlintResolvedConfig;
// wbfy:end oxlint-export
