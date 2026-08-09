import path from 'node:path';

import { logger } from '../logger.js';
import type { PackageConfig } from '../packageConfig.js';
import { fsUtil } from '../utils/fsUtil.js';
import {
  isPublishedWillboosterConfigsPackage,
  resolveWillboosterConfigModule,
} from '../utils/willboosterConfigsUtil.js';

import { normalizeConfigContent } from './configContent.js';
import { ManagedConfigBlocks } from './managedConfigBlock.js';

const managedConfigBlocks = new ManagedConfigBlocks({
  blockNames: ['base', 'export'],
  markerPrefix: 'oxlint',
  toolName: 'oxlint',
});

export async function generateOxlintConfig(config: PackageConfig, _rootConfig: PackageConfig): Promise<void> {
  return logger.functionIgnoringException('generateOxlintConfig', async () => {
    // willbooster-configs publishes config files as product code, so generation
    // must not replace package-provided linter settings. Generated files with
    // managed blocks are still safe to update.
    const shouldPreservePublishedLinterConfig = isPublishedWillboosterConfigsPackage(config);
    const filePath = path.resolve(config.dirPath, 'oxlint.config.ts');
    const existingContent = await fsUtil.readFileIfExists(filePath);
    const shouldPreserveExistingContent =
      shouldPreservePublishedLinterConfig && existingContent && !managedConfigBlocks.hasManagedBlocks(existingContent);
    const desiredContent = shouldPreserveExistingContent
      ? existingContent
      : managedConfigBlocks.getConfigContent({
          desiredContent: getConfigContent(config),
          existingContent,
          filePath,
        });

    if (
      normalizeConfigContent(existingContent) !== normalizeConfigContent(desiredContent) &&
      !(await fsUtil.generateFile(filePath, desiredContent))
    ) {
      return;
    }
  });
}

function getConfigContent(config: PackageConfig): string {
  const isRootConfig = config.isRoot;
  const oxlintBaseConfigModule = resolveWillboosterConfigModule(config, '@willbooster/oxlint-config');

  // Do not collapse this to a static import for every package. CommonJS packages
  // type-check auto-discovered oxlint.config.ts as CommonJS, so importing the ESM
  // @willbooster/oxlint-config package triggers TS1479. Keep this in sync with
  // literacy-test's generated config pattern.
  // No /// <reference types> line: the wbfy-generated tsconfig already covers *.config.ts with
  // types ["bun"], which types require/module.exports, while a "node" reference breaks under
  // Bun's isolated linker where the undeclared @types/node is unresolvable (TS2688).
  if (!config.isEsmPackage) {
    return `${managedConfigBlocks.getBlock(
      'base',
      `import type { OxlintConfig } from 'oxlint';

// oxlint-disable unicorn/prefer-module -- Oxlint only auto-discovers .ts config files, and CommonJS avoids ESM package loading issues.
const oxlintBaseConfig = require('${oxlintBaseConfigModule}');

${getResolvedConfigContent('oxlintBaseConfig.default ?? oxlintBaseConfig', isRootConfig)}`
    )}

${managedConfigBlocks.getBlock('export', 'module.exports = oxlintResolvedConfig;')}
`;
  }

  return `${managedConfigBlocks.getBlock(
    'base',
    `import type { OxlintConfig } from 'oxlint';

import oxlintBaseConfig from '${oxlintBaseConfigModule}';

${getResolvedConfigContent('oxlintBaseConfig', isRootConfig)}`
  )}

${managedConfigBlocks.getBlock('export', 'export default oxlintResolvedConfig;')}
`;
}

function getResolvedConfigContent(baseConfigName: string, isRootConfig: boolean): string {
  if (isRootConfig) {
    return `// Keep a package-local copy so repositories can add settings outside
// managed blocks without mutating the shared imported config object.
const oxlintResolvedConfig: OxlintConfig = structuredClone(${baseConfigName});
// The type-aware options make lint perform type checking. Always force them on here,
// inside the managed block, so no customization can silently disable type checking.
oxlintResolvedConfig.options = { ...oxlintResolvedConfig.options, typeAware: true, typeCheck: true };`;
  }

  return `// Oxlint rejects the root-only type-aware options outside the root config, so delete them
// here. This does NOT disable type checking: the lint commands pass the --type-aware and
// --type-check flags explicitly.
const oxlintResolvedConfig: OxlintConfig = structuredClone(${baseConfigName});
delete oxlintResolvedConfig.options;`;
}
