import fs from 'node:fs';
import path from 'node:path';

import { logger } from '../logger.js';
import type { PackageConfig } from '../packageConfig.js';
import { fsUtil } from '../utils/fsUtil.js';
import { resolveWillboosterConfigModule } from '../utils/willboosterConfigsUtil.js';

import { normalizeConfigContent } from './configContent.js';
import { ManagedConfigBlocks } from './managedConfigBlock.js';

const managedConfigBlocks = new ManagedConfigBlocks({
  blockNames: ['base', 'export'],
  markerPrefix: 'oxfmt',
  toolName: 'oxfmt',
});

export async function generateOxfmtConfig(config: PackageConfig): Promise<void> {
  return logger.functionIgnoringException('generateOxfmtConfig', async () => {
    const legacyJsonConfigPath = path.resolve(config.dirPath, '.oxfmtrc.json');
    const filePath = path.resolve(config.dirPath, 'oxfmt.config.ts');
    const existingContent = await fsUtil.readFileIfExists(filePath);
    const desiredContent = managedConfigBlocks.getConfigContent({
      desiredContent: getConfigContent(config),
      existingContent,
      filePath,
    });
    // Oxfmt rejects a directory containing both config spellings. Remove the legacy file only
    // after its managed replacement exists; otherwise a refused write could leave the project
    // without any formatter configuration.
    if (
      normalizeConfigContent(existingContent) !== normalizeConfigContent(desiredContent) &&
      !(await fsUtil.generateFile(filePath, desiredContent))
    ) {
      return;
    }
    if (
      managedConfigBlocks.hasCompleteManagedBlocks(desiredContent) &&
      fs.existsSync(legacyJsonConfigPath) &&
      (await fsUtil.removeConfined(legacyJsonConfigPath))
    ) {
      console.info(`Removed superseded ${legacyJsonConfigPath} in favor of ${filePath}.`);
    }
  });
}

function getConfigContent(config: PackageConfig): string {
  const oxfmtBaseConfigModule = resolveWillboosterConfigModule(config, '@willbooster/oxfmt-config');

  // CommonJS packages need require/module.exports here: oxfmt config files are
  // only auto-discovered as .ts, and the shared config package is ESM-only.
  // No /// <reference types> line: the wbfy-generated tsconfig already covers *.config.ts with
  // types ["bun"], which types require/module.exports, while a "node" reference breaks under
  // Bun's isolated linker where the undeclared @types/node is unresolvable (TS2688).
  if (!config.isEsmPackage) {
    return `${managedConfigBlocks.getBlock(
      'base',
      `import type { OxfmtConfig } from 'oxfmt';

// oxlint-disable unicorn/prefer-module -- Oxfmt config files are only auto-discovered as .ts, and CommonJS avoids ESM package loading issues.
const oxfmtConfig = require('${oxfmtBaseConfigModule}');

const oxfmtResolvedConfig: OxfmtConfig = oxfmtConfig.default ?? oxfmtConfig;`
    )}

${managedConfigBlocks.getBlock('export', 'module.exports = oxfmtResolvedConfig;')}
`;
  }

  return `${managedConfigBlocks.getBlock(
    'base',
    `import type { OxfmtConfig } from 'oxfmt';

import config from '${oxfmtBaseConfigModule}';

const oxfmtResolvedConfig: OxfmtConfig = config;`
  )}

${managedConfigBlocks.getBlock('export', 'export default oxfmtResolvedConfig;')}
`;
}
