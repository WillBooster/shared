// wbfy:start oxlint-base
import type { OxlintConfig } from 'oxlint';

import oxlintBaseConfig from '@willbooster/oxlint-config';

const oxlintResolvedConfig: OxlintConfig = structuredClone(oxlintBaseConfig);
delete oxlintResolvedConfig.options;
// wbfy:end oxlint-base

import { portableRuntimeOverrides } from '../../oxlint.config.ts';

oxlintResolvedConfig.overrides = [...(oxlintResolvedConfig.overrides ?? []), ...portableRuntimeOverrides];

oxlintResolvedConfig.ignorePatterns = oxlintResolvedConfig.ignorePatterns?.filter((pattern) => pattern !== '**/bin/**');

// wbfy:start oxlint-export
export default oxlintResolvedConfig;
// wbfy:end oxlint-export
