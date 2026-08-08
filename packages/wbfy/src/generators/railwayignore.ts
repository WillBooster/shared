import path from 'node:path';

import { logger } from '../logger.js';
import type { PackageConfig } from '../packageConfig.js';
import { fsUtil } from '../utils/fsUtil.js';
import { promisePool } from '../utils/promisePool.js';

const managedScriptsBlock = `scripts/**
!scripts/
!scripts/*.sh`;

export async function fixRailwayignore(config: PackageConfig): Promise<void> {
  return logger.functionIgnoringException('fixRailwayignore', async () => {
    const filePath = path.resolve(config.dirPath, '.railwayignore');
    const content = await fsUtil.readFileIfExists(filePath);
    if (!content) return;

    let newContent = content.replace(/^scripts\/$/m, managedScriptsBlock);
    // `railway up` strips gitignored files from the uploaded build context, so the generated
    // non-secret .docker.env (`wb gen-docker-env` output) needs an explicit un-ignore to reach
    // the remote Docker build.
    if (config.doesContainDockerfile && !/^!\.docker\.env$/m.test(newContent)) {
      newContent = `!.docker.env\n${newContent}`;
    }
    if (newContent === content) return;

    await promisePool.run(() => fsUtil.generateFile(filePath, newContent));
  });
}
