import child_process from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { logger } from '../logger.js';
import type { PackageConfig } from '../packageConfig.js';
import { extensions } from '../utils/extensions.js';
import { fsUtil } from '../utils/fsUtil.js';
import { promisePool } from '../utils/promisePool.js';

const gitOutputMaxBuffer = 64 * 1024 * 1024;

// cf. https://bun.sh/guides/install/git-diff-bun-lockfile
// `-text` keeps the macOS template's `Icon\r\r` rule of the ignore files intact. `text=auto` keeps it only because the
// lone CR makes the file look binary; a `text` attribute would strip one CR per checkin until the rule matches nothing.
const newContent = `* text=auto

.gitignore -text
.prettierignore -text

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
    await promisePool.runAndWaitForReturnValue(() => fsUtil.generateFile(filePath, newContent));
  });
}

export function renormalizeTrackedTextFiles(dirPath: string): void {
  let output: string;
  try {
    output = child_process.execFileSync('git', ['ls-files', '--eol', '-z'], {
      cwd: dirPath,
      encoding: 'utf8',
      maxBuffer: gitOutputMaxBuffer,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    console.warn(`Skipped tracked line-ending renormalization: ${(error as Error).message}`);
    return;
  }
  let renormalizedCount = 0;
  for (const record of output.split('\0')) {
    const separatorIndex = record.indexOf('\t');
    if (separatorIndex === -1) continue;

    const attributes = record.slice(0, separatorIndex);
    // Only `text` with `eol` converts a blob that already holds CR in the index: Git keeps such a blob under
    // `text=auto`, even with `eol`, so CRs there are content (e.g. a fixture testing CR) and must stay.
    if (!/^i\/(?:crlf|mixed)\s/u.test(attributes) || !/\sattr\/text eol=(?:lf|crlf)(?:\s|$)/u.test(attributes)) {
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
    renormalizedCount++;
  }
  if (renormalizedCount > 0) {
    console.info(`Renormalized line endings in ${renormalizedCount} tracked file(s).`);
  }
}
