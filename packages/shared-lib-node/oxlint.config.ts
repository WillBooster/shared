// wbfy:start oxlint-base
import type { OxlintConfig } from 'oxlint';

import oxlintBaseConfig from '@willbooster/oxlint-config';

// Oxlint only supports type-aware options in the root config, while it
// still auto-discovers package-local config files in monorepos. Keep this as a
// structured clone so packages can delete root-only settings without mutating
// the shared imported config object.
const oxlintResolvedConfig: OxlintConfig = structuredClone(oxlintBaseConfig);
delete oxlintResolvedConfig.options;
// wbfy:end oxlint-base

// wbfy:start oxlint-export
export default oxlintResolvedConfig;
// wbfy:end oxlint-export
