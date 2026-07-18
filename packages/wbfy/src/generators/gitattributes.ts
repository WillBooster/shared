import path from 'node:path';

import { logger } from '../logger.js';
import type { PackageConfig } from '../packageConfig.js';
import { extensions } from '../utils/extensions.js';
import { fsUtil } from '../utils/fsUtil.js';
import { promisePool } from '../utils/promisePool.js';

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
