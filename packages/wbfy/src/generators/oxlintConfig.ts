import fs from 'node:fs';
import path from 'node:path';

import { logger } from '../logger.js';
import type { PackageConfig } from '../packageConfig.js';
import { fsUtil } from '../utils/fsUtil.js';
import { promisePool } from '../utils/promisePool.js';
import { isPublishedWillboosterConfigsPackage } from '../utils/willboosterConfigsUtil.js';

import { normalizeToolConfigContent } from './toolConfigContent.js';

export async function generateOxlintConfig(config: PackageConfig, _rootConfig: PackageConfig): Promise<void> {
  return logger.functionIgnoringException('generateOxlintConfig', async () => {
    // willbooster-configs publishes config files as product code, so migration
    // must not remove package-provided linter settings.
    const shouldPreservePublishedLinterConfig = isPublishedWillboosterConfigsPackage(config);
    const filePath = path.resolve(config.dirPath, 'oxlint.config.ts');
    const existingContent = await fsUtil.readFileIgnoringError(filePath);
    const desiredContent =
      shouldPreservePublishedLinterConfig && existingContent
        ? existingContent
        : getConfigContentWithManagedBlocks(config, existingContent, filePath);

    const promises: Promise<void>[] = [];
    if (!shouldPreservePublishedLinterConfig) {
      promises.push(
        promisePool.run(() => fs.promises.rm(path.resolve(config.dirPath, '.oxlintrc.json'), { force: true })),
        promisePool.run(() => fs.promises.rm(path.resolve(config.dirPath, 'biome.json'), { force: true })),
        promisePool.run(() => fs.promises.rm(path.resolve(config.dirPath, 'biome.jsonc'), { force: true })),
        promisePool.run(() => fs.promises.rm(path.resolve(config.dirPath, '.eslintrc'), { force: true })),
        promisePool.run(() => fs.promises.rm(path.resolve(config.dirPath, '.eslintrc.cjs'), { force: true })),
        promisePool.run(() => fs.promises.rm(path.resolve(config.dirPath, '.eslintrc.js'), { force: true })),
        promisePool.run(() => fs.promises.rm(path.resolve(config.dirPath, '.eslintrc.json'), { force: true })),
        promisePool.run(() => fs.promises.rm(path.resolve(config.dirPath, '.eslintrc.yaml'), { force: true })),
        promisePool.run(() => fs.promises.rm(path.resolve(config.dirPath, '.eslintrc.yml'), { force: true })),
        promisePool.run(() => fs.promises.rm(path.resolve(config.dirPath, 'eslint.config.cjs'), { force: true })),
        promisePool.run(() => fs.promises.rm(path.resolve(config.dirPath, 'eslint.config.js'), { force: true })),
        promisePool.run(() => fs.promises.rm(path.resolve(config.dirPath, 'eslint.config.mjs'), { force: true })),
        promisePool.run(() => fs.promises.rm(path.resolve(config.dirPath, 'eslint.config.ts'), { force: true }))
      );
    }
    if (normalizeToolConfigContent(existingContent) !== normalizeToolConfigContent(desiredContent)) {
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
  if (config.isEsmPackage) {
    return `${getManagedBlock('base', "import config from '@willbooster/oxlint-config';")}

${getManagedBlock('export', 'export default config;')}
`;
  }

  return `${getManagedBlock(
    'base',
    `// oxlint-disable unicorn/prefer-module -- Oxlint only auto-discovers .ts config files, and CommonJS avoids Node typeless ESM warnings.
const oxlintBaseConfig = require('@willbooster/oxlint-config');

const config = oxlintBaseConfig.default ?? oxlintBaseConfig;`
  )}

${getManagedBlock('export', 'module.exports = config;')}
`;
}

function hasManagedBlocks(content: string): boolean {
  return content.includes(getStartMarker('base')) || content.includes(getStartMarker('export'));
}

function replaceManagedBlocks(existingContent: string, desiredContent: string, filePath: string): string {
  let content = existingContent;
  for (const blockName of ['base', 'export'] as const) {
    const replacement = extractManagedBlock(desiredContent, blockName);
    if (!replacement) continue;

    const nextContent = replaceManagedBlock(content, blockName, replacement);
    if (!nextContent) {
      console.warn(`Skipped updating incomplete ${blockName} block in oxlint config: ${filePath}`);
      return existingContent;
    }
    content = nextContent;
  }
  return content;
}

function extractManagedBlock(content: string, blockName: 'base' | 'export'): string | undefined {
  return new RegExp(
    `${escapeRegExp(getStartMarker(blockName))}[\\s\\S]*?${escapeRegExp(getEndMarker(blockName))}`
  ).exec(content)?.[0];
}

function replaceManagedBlock(content: string, blockName: 'base' | 'export', replacement: string): string | undefined {
  const pattern = new RegExp(
    `${escapeRegExp(getStartMarker(blockName))}[\\s\\S]*?${escapeRegExp(getEndMarker(blockName))}`
  );
  if (!pattern.test(content)) return undefined;
  return content.replace(pattern, replacement);
}

function getManagedBlock(blockName: 'base' | 'export', content: string): string {
  return `${getStartMarker(blockName)}
${content}
${getEndMarker(blockName)}`;
}

function getStartMarker(blockName: 'base' | 'export'): string {
  return `// wbfy:start oxlint-${blockName}`;
}

function getEndMarker(blockName: 'base' | 'export'): string {
  return `// wbfy:end oxlint-${blockName}`;
}

function escapeRegExp(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}
