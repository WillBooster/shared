import fs from 'node:fs';
import path from 'node:path';

import { logger } from '../logger.js';
import type { PackageConfig } from '../packageConfig.js';
import { fsUtil } from '../utils/fsUtil.js';
import { promisePool } from '../utils/promisePool.js';

import { normalizeConfigContent } from './configContent.js';

type OxfmtBlockName = 'base' | 'export';

export async function generateOxfmtConfig(config: PackageConfig): Promise<void> {
  return logger.functionIgnoringException('generateOxfmtConfig', async () => {
    const legacyJsonConfigPath = path.resolve(config.dirPath, '.oxfmtrc.json');
    const filePath = path.resolve(config.dirPath, 'oxfmt.config.ts');
    const existingContent = await fsUtil.readFileIgnoringError(filePath);
    const desiredContent = getConfigContentWithManagedBlocks(config, existingContent, filePath);
    const promises = [promisePool.run(() => fs.promises.rm(legacyJsonConfigPath, { force: true }))];
    if (normalizeConfigContent(existingContent) !== normalizeConfigContent(desiredContent)) {
      promises.push(promisePool.run(() => fsUtil.generateFile(filePath, desiredContent)));
    }
    await Promise.all(promises);
  });
}

function getConfigContentWithManagedBlocks(
  config: PackageConfig,
  existingContent: string | undefined,
  filePath: string
): string {
  const desiredContent = getConfigContent(config);
  if (!existingContent) return desiredContent;
  if (hasManagedBlocks(existingContent)) return replaceManagedBlocks(existingContent, desiredContent, filePath);
  return desiredContent;
}

function getConfigContent(config: PackageConfig): string {
  // CommonJS packages need require/module.exports here: oxfmt config files are
  // only auto-discovered as .ts, and the shared config package is ESM-only.
  if (!config.isEsmPackage) {
    return `${getManagedBlock(
      'base',
      `// oxlint-disable unicorn/prefer-module -- Oxfmt config files are only auto-discovered as .ts, and CommonJS avoids Node typeless ESM warnings.
const oxfmtConfig = require('@willbooster/oxfmt-config');

const config = oxfmtConfig.default ?? oxfmtConfig;`
    )}

${getManagedBlock('export', 'module.exports = config;')}
`;
  }

  return `${getManagedBlock('base', "import config from '@willbooster/oxfmt-config';")}

${getManagedBlock('export', 'export default config;')}
`;
}

function hasManagedBlocks(content: string): boolean {
  return content.includes(getStartMarker('base')) || content.includes(getStartMarker('export'));
}

function replaceManagedBlocks(existingContent: string, desiredContent: string, filePath: string): string {
  let content = existingContent;
  for (const blockName of ['base', 'export'] satisfies OxfmtBlockName[]) {
    const replacement = extractManagedBlock(desiredContent, blockName);
    if (!replacement) continue;

    const nextContent = replaceManagedBlock(content, blockName, replacement);
    if (!nextContent) {
      console.warn(`Skipped updating incomplete ${blockName} block in oxfmt config: ${filePath}`);
      return existingContent;
    }
    content = nextContent;
  }
  return content;
}

function extractManagedBlock(content: string, blockName: OxfmtBlockName): string | undefined {
  return getManagedBlockRegExp(blockName).exec(content)?.[0];
}

function replaceManagedBlock(content: string, blockName: OxfmtBlockName, replacement: string): string | undefined {
  const pattern = getManagedBlockRegExp(blockName);
  if (!pattern.test(content)) return undefined;
  return content.replace(pattern, replacement);
}

function getManagedBlockRegExp(blockName: OxfmtBlockName): RegExp {
  return new RegExp(`${escapeRegExp(getStartMarker(blockName))}[\\s\\S]*?${escapeRegExp(getEndMarker(blockName))}`);
}

function getManagedBlock(blockName: OxfmtBlockName, content: string): string {
  return `${getStartMarker(blockName)}
${content}
${getEndMarker(blockName)}`;
}

function getStartMarker(blockName: OxfmtBlockName): string {
  return `// wbfy:start oxfmt-${blockName}`;
}

function getEndMarker(blockName: OxfmtBlockName): string {
  return `// wbfy:end oxfmt-${blockName}`;
}

function escapeRegExp(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}
