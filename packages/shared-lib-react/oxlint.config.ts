// wbfy:start oxlint-base
import type { OxlintConfig } from 'oxlint';

import oxlintBaseConfig from '@willbooster/oxlint-config';

// Oxlint rejects the root-only type-aware options outside the root config, so delete them
// here. This does NOT disable type checking: the lint commands pass the --type-aware and
// --type-check flags explicitly.
const oxlintResolvedConfig: OxlintConfig = structuredClone(oxlintBaseConfig);
delete oxlintResolvedConfig.options;
// wbfy:end oxlint-base

// wbfy:start oxlint-export
export default oxlintResolvedConfig;
// wbfy:end oxlint-export
