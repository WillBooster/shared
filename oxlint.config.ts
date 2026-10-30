// wbfy:start oxlint-base
import type { OxlintConfig } from 'oxlint';

import oxlintBaseConfig from '@willbooster/oxlint-config';

const oxlintResolvedConfig: OxlintConfig = structuredClone(oxlintBaseConfig);
oxlintResolvedConfig.options = { ...oxlintResolvedConfig.options, typeAware: true, typeCheck: true };
// wbfy:end oxlint-base

export const portableRuntimeOverrides: NonNullable<OxlintConfig['overrides']> = [
  {
    files: ['src/**/*', 'bin/**/*', 'scripts/**/*'],
    rules: {
      'no-restricted-globals': ['error', { name: 'Bun', message: 'Production code must support Node.js and Bun.' }],
      'no-restricted-imports': ['error', { patterns: ['bun', 'bun:*'] }],
    },
  },
];
oxlintResolvedConfig.overrides = [...(oxlintResolvedConfig.overrides ?? []), ...portableRuntimeOverrides];

// wbfy:start oxlint-export
export default oxlintResolvedConfig;
// wbfy:end oxlint-export
