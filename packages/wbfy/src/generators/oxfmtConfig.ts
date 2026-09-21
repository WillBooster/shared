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
    const filePath = path.resolve(config.dirPath, 'oxfmt.config.ts');
    const existingContent = await fsUtil.readFileIfExists(filePath);
    const desiredContent = managedConfigBlocks.getConfigContent({
      desiredContent: getConfigContent(config),
      existingContent,
      filePath,
    });
    if (normalizeConfigContent(existingContent) !== normalizeConfigContent(desiredContent)) {
      await fsUtil.generateFile(filePath, desiredContent);
    }
  });
}

function getConfigContent(config: PackageConfig): string {
  const oxfmtBaseConfigModule = resolveWillboosterConfigModule(config, '@willbooster/oxfmt-config');

  // CommonJS packages need require/module.exports here: oxfmt config files are
  // only auto-discovered as .ts, and the shared config package is ESM-only.
  // No /// <reference types> line: the generated tsconfig covers *.config.ts; standard projects
  // get CommonJS globals from Bun's types, while React Native declares its one missing global
  // locally. A "node" reference breaks under the isolated linker without @types/node (TS2688).
  if (!config.isEsmPackage) {
    return `${managedConfigBlocks.getBlock(
      'base',
      `import type { OxfmtConfig } from 'oxfmt';

// oxlint-disable unicorn/prefer-module -- Oxfmt config files are only auto-discovered as .ts, and CommonJS avoids ESM package loading issues.
const oxfmtConfig = require('${oxfmtBaseConfigModule}');

const oxfmtResolvedConfig: OxfmtConfig = oxfmtConfig.default ?? oxfmtConfig;`
    )}

${managedConfigBlocks.getBlock(
  'export',
  config.depending.reactNative
    ? 'declare const module: { exports: OxfmtConfig };\n\nmodule.exports = oxfmtResolvedConfig;'
    : 'module.exports = oxfmtResolvedConfig;'
)}
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
