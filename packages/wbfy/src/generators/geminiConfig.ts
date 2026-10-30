import path from 'node:path';

import merge from 'deepmerge';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

import { logger } from '../logger.js';
import type { PackageConfig } from '../packageConfig.js';
import { fsUtil } from '../utils/fsUtil.js';
import { overwriteMerge } from '../utils/mergeUtil.js';
import { runAllInPool } from '../utils/promisePool.js';
import {
  generateAgentCodingStyle,
  getDefaultProseLanguage,
  readAgentsExtraContent,
  usesReactCompiler,
} from './agents.js';

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
    const styleguideFilePath = path.resolve(dirPath, 'styleguide.md');

    let newConfig: object = structuredClone(defaultConfig);
    const oldContent = await fsUtil.readFileConfinedIfExists(configFilePath);
    if (oldContent !== undefined) {
      try {
        const oldConfig = parseYaml(oldContent);
        // Merge only a mapping: empty, comment-only, or scalar YAML would either throw in
        // merge.all or pollute the config with index keys.
        if (oldConfig && typeof oldConfig === 'object' && !Array.isArray(oldConfig)) {
          newConfig = merge.all([newConfig, oldConfig, newConfig], { arrayMerge: overwriteMerge });
        }
      } catch {
        // do nothing - file can't be parsed
      }
    }

    const yamlContent = stringifyYaml(newConfig);

    const extraContent = await readAgentsExtraContent(config.dirPath);
    const codingRuleExtraContent = extraContent?.trimStart().startsWith('#') ? undefined : extraContent;
    const styleguideContent = `Review in ${getDefaultProseLanguage(config)} based on the following coding standards.\n\n${generateAgentCodingStyle(config, allConfigs, await usesReactCompiler(allConfigs))}${
      codingRuleExtraContent ? `\n${codingRuleExtraContent.trimEnd()}` : ''
    }`;

    await runAllInPool([
      () => fsUtil.generateFile(configFilePath, yamlContent),
      () => fsUtil.generateFile(styleguideFilePath, styleguideContent),
    ]);
  });
}
