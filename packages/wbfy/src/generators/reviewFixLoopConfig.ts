import path from 'node:path';

import { logger } from '../logger.js';
import type { PackageConfig } from '../packageConfig.js';
import { fsUtil } from '../utils/fsUtil.js';
import { jsoncUtil } from '../utils/jsoncUtil.js';

/**
 * Where every WillBooster member's ReviewFixLoop agent sends its `custom/<model>` requests: the
 * organization's LLM proxy, with a member token the proxy's CLI issues. The repository's setting
 * takes precedence over each member's own, so the organization's repositories always use it.
 */
const rflAgentSettings = {
  custom: {
    baseUrl: 'https://llm.willbooster.com/v1',
    apiKeyCommand: 'bunx @willbooster-private/llm-proxy token',
  },
};

export async function generateReviewFixLoopConfig(config: PackageConfig): Promise<void> {
  return logger.functionIgnoringException('generateReviewFixLoopConfig', async () => {
    const filePath = path.resolve(config.dirPath, '.review-fix-loop.jsonc');
    const oldContent = await fsUtil.readFileIfExists(filePath);
    if (
      oldContent !== undefined &&
      !jsoncUtil.isTriviaOnly(oldContent) &&
      !jsoncUtil.parseObjectIgnoringError(oldContent)
    ) {
      console.warn(`Skipped generating ${filePath} because the existing content is not parsable as JSONC.`);
      return;
    }
    const { content, keysLosingComments } = jsoncUtil.stringifyPreservingTrivia(oldContent, {
      rflAgent: rflAgentSettings,
    });
    if (content.trim() === oldContent?.trim()) return;
    if (!(await fsUtil.generateFile(filePath, content))) return;
    for (const key of keysLosingComments) {
      console.warn(`Comments inside "${key}" were dropped while rewriting it in ${filePath}.`);
    }
  });
}
