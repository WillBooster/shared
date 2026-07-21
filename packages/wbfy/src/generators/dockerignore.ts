import fs from 'node:fs';
import path from 'node:path';

import { logger } from '../logger.js';
import type { PackageConfig } from '../packageConfig.js';
import { fsUtil } from '../utils/fsUtil.js';
import { ignoreFileUtil } from '../utils/ignoreFileUtil.js';
import { promisePool } from '../utils/promisePool.js';

// Exercode deploys Git-based private packages from node_modules, but the Docker context should stay narrow.
const includedNodeModulesPatterns = ['@willbooster'];

const commonContent = `
**/.DS_Store
**/.bun-cache
**/.cache
**/.claude
**/.cursor
**/.editorconfig
**/.eslintcache
**/.gemini
**/.git
**/.gitattributes
**/.github
**/.gitignore
**/.idea
**/.lefthook
**/.mypy_cache
**/.next/cache
**/.npm
**/.parcel-cache
**/.pnpm-store
**/.pytest_cache
**/.railwayignore
**/.releaserc.json
**/.ruff_cache
**/.tmp
**/.tmp-*/**
**/.turbo
**/.tox
**/.vscode
**/.yarn/cache
**/*.sqlite3*
**/.yarn/install-state.gz
**/.venv
**/__pycache__
**/*.log
**/*.pyc
**/*.tsbuildinfo
**/coverage
**/node_modules/**
${includedNodeModulesPatterns
  .map(
    (pattern) => `!**/node_modules/${pattern}
!**/node_modules/${pattern}/**`
  )
  .join('\n')}
**/node_modules/.cache
**/playwright-report
**/storybook-static
**/target
**/test-results
`;

export async function generateDockerignore(config: PackageConfig): Promise<void> {
  return logger.functionIgnoringException('generateDockerignore', async () => {
    const filePath = path.resolve(config.dirPath, '.dockerignore');
    if (config.doesContainDockerfile) {
      const content = (await fsUtil.readFileIfExists(filePath)) ?? '';
      const headUserContent = ignoreFileUtil.getHeadUserContent(content);
      const tailUserContent = ignoreFileUtil.getTailUserContent(content);

      const newContent = headUserContent + commonContent + tailUserContent;
      await promisePool.run(() => fsUtil.generateFile(filePath, newContent));
    } else {
      await fs.promises.rm(filePath, { force: true });
    }
  });
}
