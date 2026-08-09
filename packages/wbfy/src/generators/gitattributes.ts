import fs from 'node:fs';
import path from 'node:path';

import { logger } from '../logger.js';
import type { PackageConfig } from '../packageConfig.js';
import { extensions } from '../utils/extensions.js';
import { fsUtil } from '../utils/fsUtil.js';
import { promisePool } from '../utils/promisePool.js';
import { spawnSyncAndReturnRawStdout } from '../utils/spawnUtil.js';

// cf. https://bun.sh/guides/install/git-diff-bun-lockfile
const newContent = `* text=auto

# The macOS template's \`Icon\\r\\r\` rule needs its literal carriage returns: \`text=auto\`
# normalization strips one CR per checkin, degrading the rule until it matches nothing.
.gitignore -text

*.lockb binary diff=lockb
*.vcproj text eol=crlf

${[...extensions.codeWith2IndentSize, ...extensions.codeWith4IndentSize, ...extensions.markdownLike]
  .map((ext) => `*.${ext} text eol=lf`)
  .join('\n')}

dist/** linguist-generated=true
`;

export async function generateGitattributes(config: PackageConfig): Promise<void> {
  return logger.functionIgnoringException('generateGitattributes', async () => {
    const filePath = path.resolve(config.dirPath, '.gitattributes');
    await promisePool.run(() => fsUtil.generateFile(filePath, newContent));
  });
}

export function renormalizeTrackedTextFiles(dirPath: string): void {
  const attributesFileStats = fs.lstatSync(path.resolve(dirPath, '.gitattributes'), { throwIfNoEntry: false });
  if (!attributesFileStats?.isFile()) return;

  const output = spawnSyncAndReturnRawStdout('git', ['ls-files', '--eol', '-z'], dirPath);
  for (const record of output.split('\0')) {
    const separatorIndex = record.indexOf('\t');
    if (separatorIndex === -1) continue;

    const attributes = record.slice(0, separatorIndex);
    if (!/^i\/(?:crlf|mixed)\s/u.test(attributes) || !/attr\/.*\beol=(?:lf|crlf)(?:\s|$)/u.test(attributes)) {
      continue;
    }

    const relativePath = record.slice(separatorIndex + 1);
    const trackedFilePath = path.resolve(dirPath, relativePath);
    const stats = fs.lstatSync(trackedFilePath, { throwIfNoEntry: false });
    if (!stats?.isFile()) continue;

    // Git's stat cache can hide pre-existing CRLF blobs after wbfy introduces text attributes.
    // Normalize bytes in the worktree so the caller's normal `git add -A` records the canonical
    // blob; this also prevents Prettier's metadata cache from skipping the newly changed file.
    const content = fs.readFileSync(trackedFilePath);
    fs.writeFileSync(trackedFilePath, Buffer.from(content.toString('binary').replaceAll('\r\n', '\n'), 'binary'));
  }
}
