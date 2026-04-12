import fs from 'node:fs';
import path from 'node:path';

import { sortPackageJson } from 'sort-package-json';

import { logger } from '../logger.js';
import { fsUtil } from '../utils/fsUtil.js';

export async function fixTestDirectoriesUpdatingPackageJson(packageDirPaths: string[]): Promise<void> {
  return logger.functionIgnoringException('fixTestDirectoriesUpdatingPackageJson', async () => {
    await Promise.all(
      packageDirPaths.map(async (packageDirPath) => {
        const packageJsonPath = path.join(packageDirPath, 'package.json');
        if (!fs.existsSync(packageJsonPath)) return;

        const newTestDirPath = path.join(packageDirPath, 'test');
        for (const oldTestDirName of ['__tests__', 'tests']) {
          const oldTestDirPath = path.join(packageDirPath, oldTestDirName);
          try {
            await moveTestDirectory(oldTestDirPath, newTestDirPath);
            const packageJson = JSON.parse(await fs.promises.readFile(packageJsonPath, 'utf8')) as {
              scripts?: Record<string, string>;
            };
            let didUpdateScript = false;
            const scripts = packageJson.scripts ?? {};
            for (const [scriptName, script] of Object.entries(scripts)) {
              const newScript = script.replaceAll(oldTestDirName, 'test');
              if (script !== newScript) {
                scripts[scriptName] = newScript;
                didUpdateScript = true;
              }
            }
            packageJson.scripts = scripts;
            if (!didUpdateScript) return;

            await fsUtil.generateFile(packageJsonPath, JSON.stringify(sortPackageJson(packageJson), undefined, 2));
          } catch {
            // do nothing
          }
        }
      })
    );
  });
}

async function moveTestDirectory(oldTestDirPath: string, newTestDirPath: string): Promise<void> {
  if (!fs.existsSync(newTestDirPath)) {
    await fs.promises.rename(oldTestDirPath, newTestDirPath);
    return;
  }

  const dirents = await fs.promises.readdir(oldTestDirPath, { withFileTypes: true });
  await Promise.all(
    dirents.map(async (dirent) => {
      const oldPath = path.join(oldTestDirPath, dirent.name);
      const newPath = path.join(newTestDirPath, dirent.name);
      const newPathStat = fs.existsSync(newPath) ? await fs.promises.stat(newPath) : undefined;
      if (dirent.isDirectory() && newPathStat?.isDirectory()) {
        await moveTestDirectory(oldPath, newPath);
        return;
      }
      await fs.promises.rename(oldPath, newPath);
    })
  );
  await fs.promises.rm(oldTestDirPath, { recursive: true });
}
