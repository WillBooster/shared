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
    const usesDockerEnv = config.dockerfile
      .split('\n')
      .some((line) => !/^\s*#/u.test(line) && line.includes('.docker.env'));
    if (!content) {
      if (config.isRailway && usesDockerEnv) {
        await promisePool.run(() => fsUtil.generateFile(filePath, '!.docker.env\n'));
      }
      return;
    }

    let newContent = content.replace(/^scripts\/$/m, managedScriptsBlock);
    // `railway up` strips gitignored files from the uploaded build context, so the generated
    // non-secret .docker.env (`wb gen-docker-env` output) needs an explicit un-ignore to reach
    // the remote Docker build. Appended, not prepended: ignore files are last-match-wins, so a
    // hand-written pattern such as `*.env` earlier in the file must not silently re-exclude it.
    if (usesDockerEnv && !/^!\.docker\.env$/m.test(newContent)) {
      newContent = `${newContent.replace(/\n?$/, '\n')}!.docker.env\n`;
    } else if (!usesDockerEnv) {
      newContent = newContent.replace(/^!\.docker\.env\n?/m, '');
    }
    if (newContent === content) return;

    await promisePool.run(() =>
      newContent ? fsUtil.generateFile(filePath, newContent) : fsUtil.removeConfined(filePath)
    );
  });
}
