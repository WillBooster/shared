import { expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { generateReviewFixLoopConfig } from '../../src/generators/reviewFixLoopConfig.js';
import { jsoncUtil } from '../../src/utils/jsoncUtil.js';
import { createConfig } from '../helpers/testConfig.js';

test("replaces the repository's rflAgent while keeping its other settings and comments", async () => {
  const dirPath = await fs.promises.realpath(fs.mkdtempSync(path.join(os.tmpdir(), 'wbfy-review-fix-loop-')));
  const filePath = path.join(dirPath, '.review-fix-loop.jsonc');
  try {
    fs.writeFileSync(
      filePath,
      `{
  // Keep this repository setting.
  "exploreReviewers": true,
  "rflAgent": { "custom": { "baseUrl": "http://localhost:11434/v1" } },
}
`
    );

    await generateReviewFixLoopConfig(createConfig({ dirPath, isRoot: true }));

    const content = fs.readFileSync(filePath, 'utf8');
    expect(content).toContain('// Keep this repository setting.');
    expect(jsoncUtil.parseObjectIgnoringError(content)).toEqual({
      exploreReviewers: true,
      rflAgent: {
        custom: {
          baseUrl: 'https://llm.willbooster.com/v1',
          apiKeyCommand: 'bunx @willbooster-private/llm-proxy token',
        },
      },
    });
  } finally {
    fs.rmSync(dirPath, { recursive: true, force: true });
  }
});
