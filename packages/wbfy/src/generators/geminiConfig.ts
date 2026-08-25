import fs from 'node:fs';
import path from 'node:path';

import merge from 'deepmerge';

import { logger } from '../logger.js';
import type { PackageConfig } from '../packageConfig.js';
import { fsUtil } from '../utils/fsUtil.js';
import { overwriteMerge } from '../utils/mergeUtil.js';
import { promisePool } from '../utils/promisePool.js';

import { generateAgentCodingStyle, readAgentsExtraContent } from './agents.js';

const defaultConfig = {
  have_fun: true,
  code_review: {
    disable: false,
    comment_severity_threshold: 'MEDIUM',
    max_review_comments: -1,
    pull_request_opened: {
      help: false,
      summary: true,
      code_review: true,
    },
  },
  ignore_patterns: ['**/__generated__'],
};

export async function generateGeminiConfig(config: PackageConfig, allConfigs: PackageConfig[]): Promise<void> {
  return logger.functionIgnoringException('generateGeminiConfig', async () => {
    if (!config.isRoot) return;

    const dirPath = path.resolve(config.dirPath, '.gemini');
    const configFilePath = path.resolve(dirPath, 'config.yaml');
    const nonCanonicalConfigFilePath = path.resolve(dirPath, 'config.yml');
    const styleguideFilePath = path.resolve(dirPath, 'styleguide.md');

    const hasNonCanonicalConfig = !!(await fs.promises.lstat(nonCanonicalConfigFilePath).catch(() => {}));
    if (hasNonCanonicalConfig) {
      console.warn(
        `Skipped generating ${configFilePath} because ${nonCanonicalConfigFilePath} is not a supported Gemini config location. Rename it manually.`
      );
    }

    let newConfig: object = structuredClone(defaultConfig);
    const oldContent = hasNonCanonicalConfig ? undefined : await fsUtil.readFileConfinedIfExists(configFilePath);
    if (oldContent !== undefined) {
      try {
        const oldConfig = Bun.YAML.parse(oldContent);
        // Merge only a mapping: empty, comment-only, or scalar YAML would either throw in
        // merge.all or pollute the config with index keys.
        if (oldConfig && typeof oldConfig === 'object' && !Array.isArray(oldConfig)) {
          newConfig = merge.all([newConfig, oldConfig, newConfig], { arrayMerge: overwriteMerge });
        }
      } catch {
        // do nothing - file can't be parsed
      }
    }

    const yamlContent = Bun.YAML.stringify(newConfig, undefined, 2);

    const extraContent = await readAgentsExtraContent(config.dirPath);
    const codingRuleExtraContent = extraContent?.trimStart().startsWith('#') ? undefined : extraContent;
    const reviewLanguageInstruction = config.isPublicRepo
      ? 'Review in English based on the following coding standards.'
      : '以下のコーディング規約を踏まえて、日本語でレビューしてください。';
    const styleguideContent = `${reviewLanguageInstruction}\n\n${generateAgentCodingStyle(config, allConfigs)}${
      codingRuleExtraContent ? `\n${codingRuleExtraContent.trimEnd()}` : ''
    }`;

    const promises = [
      ...(hasNonCanonicalConfig ? [] : [promisePool.run(() => fsUtil.generateFile(configFilePath, yamlContent))]),
      promisePool.run(() => fsUtil.generateFile(styleguideFilePath, styleguideContent)),
    ];
    await Promise.all(promises);
  });
}
