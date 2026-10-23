// wbfy:start oxlint-base
import oxlintBaseConfig from '@willbooster/oxlint-config';
import type { OxlintConfig } from 'oxlint';

const oxlintResolvedConfig: OxlintConfig = structuredClone(oxlintBaseConfig);
delete oxlintResolvedConfig.options;
// wbfy:end oxlint-base

// wbfy:start oxlint-export
export default oxlintResolvedConfig;
// wbfy:end oxlint-export
