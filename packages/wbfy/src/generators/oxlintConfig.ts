import fs from 'node:fs';
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
    const legacyJsonConfigPath = path.resolve(config.dirPath, '.oxlintrc.json');
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

    // Oxlint rejects a directory containing both config spellings. Remove the legacy file only
    // after its managed replacement exists; otherwise a refused write could leave the project
    // without any linter configuration.
    if (
      normalizeConfigContent(existingContent) !== normalizeConfigContent(desiredContent) &&
      !(await fsUtil.generateFile(filePath, desiredContent))
    ) {
      return;
    }
    if (
      !shouldPreservePublishedLinterConfig &&
      managedConfigBlocks.hasCompleteManagedBlocks(desiredContent) &&
      fs.existsSync(legacyJsonConfigPath) &&
      (await fsUtil.removeConfined(legacyJsonConfigPath))
    ) {
      console.info(`Removed superseded ${legacyJsonConfigPath} in favor of ${filePath}.`);
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

// structuredClone keeps a package-local copy so repositories can add settings outside managed
// blocks without mutating the shared imported config object. The root config forces the type-aware
// options on inside the managed block so no customization can silently disable type checking; every
// other config deletes them because Oxlint rejects those root-only options elsewhere (type checking
// survives: the lint commands pass --type-aware and --type-check explicitly).
function getResolvedConfigContent(baseConfigName: string, isRootConfig: boolean): string {
  if (isRootConfig) {
    return `const oxlintResolvedConfig: OxlintConfig = structuredClone(${baseConfigName});
oxlintResolvedConfig.options = { ...oxlintResolvedConfig.options, typeAware: true, typeCheck: true };`;
  }

  return `const oxlintResolvedConfig: OxlintConfig = structuredClone(${baseConfigName});
delete oxlintResolvedConfig.options;`;
}
