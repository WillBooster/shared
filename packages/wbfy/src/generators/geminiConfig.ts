// oxlint-disable eslint-plugin-import/no-named-as-default-member -- Namespace YAML calls make load/dump usage clearer.
import fs from 'node:fs';
import path from 'node:path';

import merge from 'deepmerge';
import yaml from 'js-yaml';

import { logger } from '../logger.js';
import type { PackageConfig } from '../packageConfig.js';
import { fsUtil } from '../utils/fsUtil.js';
import { overwriteMerge } from '../utils/mergeUtil.js';
import { promisePool } from '../utils/promisePool.js';

import { generateAgentCodingStyle } from './agents.js';

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
    const configFilePath = path.resolve(dirPath, 'config.yml');
    const styleguideFilePath = path.resolve(dirPath, 'styleguide.md');
    const agentsExtraPath = path.resolve(config.dirPath, 'AGENTS_EXTRA.md');

    let newConfig: object = structuredClone(defaultConfig);
    try {
      const oldContent = await fs.promises.readFile(configFilePath, 'utf8');
      const oldConfig = yaml.load(oldContent) as object;
      newConfig = merge.all([newConfig, oldConfig, newConfig], { arrayMerge: overwriteMerge });
    } catch {
      // do nothing - file doesn't exist or can't be parsed
    }

    const yamlContent = yaml.dump(newConfig, {
      lineWidth: -1,
      noCompatMode: true,
      styles: {
        '!!null': 'empty',
      },
    });

    const extraContent = await fsUtil.readFileIgnoringError(agentsExtraPath);
    const codingRuleExtraContent = extraContent?.trimStart().startsWith('#') ? undefined : extraContent;
    const styleguideContent = `以下のコーディング規約を踏まえて、日本語でレビューしてください。\n\n${generateAgentCodingStyle(allConfigs)}${
      codingRuleExtraContent ? `\n${codingRuleExtraContent.trimEnd()}` : ''
    }`;

    const promises = [
      promisePool.run(() => fsUtil.generateFile(configFilePath, yamlContent)),
      promisePool.run(() => fsUtil.generateFile(styleguideFilePath, styleguideContent)),
    ];
    await Promise.all(promises);
  });
}
