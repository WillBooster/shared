import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { spawnAsync } from '@willbooster/shared-lib-node/src';
import { describe, expect, it } from 'bun:test';

import { fixJapaneseSpacing } from '../../src/utils/japaneseSpacing.js';

const original = `この 2 つの LLM

> 引用の Gmail の添付

\`\`\`sh
echo "この 2 つ"
\`\`\`
`;
const fixed = `この2つのLLM

> 引用の Gmail の添付

\`\`\`sh
echo "この 2 つ"
\`\`\`
`;

describe('fixJapaneseSpacing', () => {
  it('fixes only the Markdown files that Git and .textlintignore do not exclude', async () => {
    const dirPath = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-japanese-spacing-'));
    try {
      await spawnAsync('git', ['init', '-q'], { cwd: dirPath });
      const files = ['docs/a.md', 'raw/b.md', 'test/fixtures/c.md', 'untracked.md', 'ignored.md'];
      for (const file of files) {
        await fs.mkdir(path.dirname(path.join(dirPath, file)), { recursive: true });
        await fs.writeFile(path.join(dirPath, file), original);
      }
      await fs.writeFile(path.join(dirPath, '.gitignore'), 'ignored.md\n');
      await fs.writeFile(path.join(dirPath, '.textlintignore'), 'raw/\n');
      await spawnAsync('git', ['add', 'docs', 'raw', 'test'], { cwd: dirPath });

      await fixJapaneseSpacing(dirPath, undefined, false);

      const contents = Object.fromEntries(
        await Promise.all(files.map(async (file) => [file, await fs.readFile(path.join(dirPath, file), 'utf8')]))
      );
      expect(contents).toEqual({
        'docs/a.md': fixed,
        'raw/b.md': original,
        'test/fixtures/c.md': original,
        'untracked.md': fixed,
        'ignored.md': original,
      });
    } finally {
      await fs.rm(dirPath, { recursive: true, force: true });
    }
  });
});
