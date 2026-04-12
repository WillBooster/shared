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
            const packageJsonPath = path.join(packageDirPath, 'package.json');
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

            await fs.promises.writeFile(packageJsonPath, `${JSON.stringify(packageJson, undefined, 2)}\n`);
          } catch {
            // do nothing
          }
        }
      })
    );
  });
}
