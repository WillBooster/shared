import fs from 'node:fs';
import path from 'node:path';

import { logger } from '../logger.js';

export async function fixTestDirectoriesUpdatingPackageJson(packageDirPaths: string[]): Promise<void> {
  return logger.functionIgnoringException('fixTestDirectoriesUpdatingPackageJson', async () => {
    await Promise.all(
      packageDirPaths.map(async (packageDirPath) => {
        const newTestDirPath = path.join(packageDirPath, 'test');
        for (const oldTestDirName of ['__tests__', 'tests']) {
          const oldTestDirPath = path.join(packageDirPath, oldTestDirName);
          try {
            await fs.promises.rename(oldTestDirPath, newTestDirPath);
            const oldContent = await fs.promises.readFile(path.join(packageDirPath, 'package.json'), 'utf8');
            const newContent = oldContent.replaceAll(oldTestDirName, 'test');
            if (oldContent === newContent) return;

            await fs.promises.writeFile(path.join(packageDirPath, 'package.json'), newContent);
          } catch {
            // do nothing
          }
        }
      })
    );
  });
}
