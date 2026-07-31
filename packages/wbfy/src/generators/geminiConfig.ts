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
    // Gemini Code Assist reads only `.gemini/config.yaml`
    // (https://docs.cloud.google.com/gemini/docs/code-review/customize-repo-review); earlier wbfy
    // versions wrote `config.yml`, which Gemini silently ignores. Read the legacy file as a merge
    // source once so repository customizations migrate, then delete it below.
    const configFilePath = path.resolve(dirPath, 'config.yaml');
    const legacyConfigFilePath = path.resolve(dirPath, 'config.yml');
    const styleguideFilePath = path.resolve(dirPath, 'styleguide.md');

    let newConfig: object = structuredClone(defaultConfig);
    for (const oldFilePath of [configFilePath, legacyConfigFilePath]) {
      // The confined read skips (returns undefined for) committed symlinks resolving outside the
      // repository, so their targets' content is never copied into the tracked config.yaml.
      const oldContent = await fsUtil.readFileConfinedIfExists(oldFilePath);
      if (oldContent === undefined) continue;
      try {
        const oldConfig = yaml.load(oldContent);
        // Merge only a mapping: empty, comment-only, or scalar YAML would either throw in
        // merge.all or pollute the config with index keys.
        if (oldConfig && typeof oldConfig === 'object' && !Array.isArray(oldConfig)) {
          newConfig = merge.all([newConfig, oldConfig, newConfig], { arrayMerge: overwriteMerge });
        }
      } catch {
        // do nothing - file can't be parsed
      }
      // The higher-priority file exists; never fall back to the legacy file even when this one is
      // empty or unparseable, or superseded legacy settings would resurrect.
      break;
    }

    const yamlContent = yaml.dump(newConfig, {
      lineWidth: -1,
      noCompatMode: true,
      styles: {
        '!!null': 'empty',
      },
    });

    const extraContent = await readAgentsExtraContent(config.dirPath);
    const codingRuleExtraContent = extraContent?.trimStart().startsWith('#') ? undefined : extraContent;
    const reviewLanguageInstruction = config.isPublicRepo
      ? 'Review in English based on the following coding standards.'
      : '以下のコーディング規約を踏まえて、日本語でレビューしてください。';
    const styleguideContent = `${reviewLanguageInstruction}\n\n${generateAgentCodingStyle(allConfigs)}${
      codingRuleExtraContent ? `\n${codingRuleExtraContent.trimEnd()}` : ''
    }`;

    const promises = [
      promisePool.run(async () => {
        // Delete the ignored legacy file only after config.yaml was actually written — a skipped
        // write (e.g. a committed symlink destination) must not destroy the only usable
        // configuration — and via the containment guard so a symlinked .gemini directory can
        // never make cleanup delete files outside the repository.
        // Announce the removal of a git-tracked file (removeConfined itself logs only skips and
        // returns true even for a nonexistent path). lstat (not existsSync) keeps a
        // dangling-symlink config.yml in scope for removal.
        const legacyExists = !!(await fs.promises.lstat(legacyConfigFilePath).catch(() => {}));
        if (
          (await fsUtil.generateFile(configFilePath, yamlContent)) &&
          legacyExists &&
          (await fsUtil.removeConfined(legacyConfigFilePath))
        ) {
          console.log(`Removed ${legacyConfigFilePath}: Gemini Code Assist reads only ${configFilePath}.`);
        }
      }),
      promisePool.run(() => fsUtil.generateFile(styleguideFilePath, styleguideContent)),
    ];
    await Promise.all(promises);
  });
}
