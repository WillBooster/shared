import path from 'node:path';

import { logger } from '../logger.js';
import type { PackageConfig } from '../packageConfig.js';
import { fsUtil } from '../utils/fsUtil.js';
import { ignoreFileUtil } from '../utils/ignoreFileUtil.js';
import { promisePool } from '../utils/promisePool.js';

const commonContent = `
3rd-party/
android/
ios/
no-format/
test-fixtures/
test/fixtures/
*.d.ts
*.min.js
.yarn/
.pnp.js
`;

export async function generatePrettierignore(config: PackageConfig): Promise<void> {
  return logger.functionIgnoringException('generatePrettierignore', async () => {
    const filePath = path.resolve(config.dirPath, '.prettierignore');
    const content = (await fsUtil.readFileIgnoringError(filePath)) ?? '';
    const headUserContent = ignoreFileUtil.getHeadUserContent(content);
    const tailUserContent = ignoreFileUtil.getTailUserContent(content);

    const gitignoreFilePath = path.resolve(config.dirPath, '.gitignore');
    const gitignoreContent = (await ignoreFileUtil.readGitignoreWithoutSeparators(gitignoreFilePath)) || '';

    let additionalContent = '';
    if (config.doesContainPubspecYaml) {
      additionalContent = `
android/app/
ios/Runner/Assets.xcassets/
pubspec.yaml
`;
    }

    const newContent = headUserContent + commonContent + additionalContent + gitignoreContent + tailUserContent;
    await promisePool.run(() => fsUtil.generateFile(filePath, newContent));
  });
}
