import fs from 'node:fs';
import path from 'node:path';

import fg from 'fast-glob';

import { isReusableWorkflowsRepo } from '../generators/workflow.js';
import { logger } from '../logger.js';
import { options } from '../options.js';
import type { PackageConfig } from '../packageConfig.js';
import { fsUtil } from '../utils/fsUtil.js';
import { globIgnore } from '../utils/globUtil.js';
import { promisePool } from '../utils/promisePool.js';

export async function fixTypos(packageConfig: PackageConfig): Promise<void> {
  return logger.functionIgnoringException('fixTypos', async () => {
    if (isReusableWorkflowsRepo(packageConfig.repository)) return;

    const dirPath = packageConfig.dirPath;
    const docFiles = await fg.glob('**/*.md', { dot: true, cwd: dirPath, ignore: globIgnore });
    if (options.isVerbose) {
      console.info(`Found ${docFiles.length} markdown files in ${dirPath}`);
    }
    for (const mdFile of docFiles) {
      const filePath = path.join(dirPath, mdFile);
      await promisePool.run(async () => {
        const content = await fs.promises.readFile(filePath, 'utf8');
        let newContent = fixTyposInText(content);
        newContent = replaceWithConfig(newContent, packageConfig, 'doc');
        if (content !== newContent) {
          await fsUtil.generateFile(filePath, newContent);
        }
      });
    }

    const tsFiles = await fg.glob(
      [
        '{app,src,test,scripts}/**/*.{cjs,mjs,js,jsx,cts,mts,ts,tsx}',
        'packages/**/{app,src,test,scripts}/**/*.{cjs,mjs,js,jsx,cts,mts,ts,tsx}',
      ],
      { dot: true, cwd: dirPath, ignore: globIgnore }
    );
    if (options.isVerbose) {
      console.info(`Found ${tsFiles.length} TypeScript files in ${dirPath}`);
    }
    for (const tsFile of tsFiles) {
      const filePath = path.join(dirPath, tsFile);
      const oldContent = await fs.promises.readFile(filePath, 'utf8');
      let newContent = fixTyposInCode(oldContent);
      newContent = replaceWithConfig(newContent, packageConfig, 'ts');

      if (oldContent === newContent) continue;
      await fsUtil.generateFile(filePath, newContent);
    }

    const textBasedFiles = await fg.glob('**/*.{csv,htm,html,tsv,xml,yaml,yml}', {
      dot: true,
      cwd: dirPath,
      ignore: globIgnore,
    });
    if (options.isVerbose) {
      console.info(`Found ${textBasedFiles.length} text-based files in ${dirPath}`);
    }
    for (const file of textBasedFiles) {
      const filePath = path.join(dirPath, file);
      const oldContent = await fs.promises.readFile(filePath, 'utf8');
      let newContent = fixTyposInText(oldContent);
      newContent = replaceWithConfig(newContent, packageConfig, 'text');

      if (oldContent === newContent) continue;
      await fsUtil.generateFile(filePath, newContent);
    }

    await promisePool.promiseAll();
  });
}

export function fixTyposInText(content: string): string {
  return content
    .replaceAll(/\bc\.f\.([^$])/g, 'cf.$1')
    .replaceAll(/\beg\.([^$])/g, 'e.g.$1')
    .replaceAll(/\bie\.([^$])/g, 'i.e.$1');
}

function fixTyposInCode(content: string): string {
  return content
    .replaceAll(/\/\/(.*)c\.f\./g, '//$1cf.')
    .replaceAll(/\/\/(.*)eg\./g, '//$1e.g.')
    .replaceAll(/\/\/(.*)ie\./g, '//$1i.e.');
}

function replaceWithConfig(newContent: string, packageConfig: PackageConfig, propName: 'doc' | 'ts' | 'text'): string {
  for (const [before, after] of Object.entries(packageConfig.wbfyJson?.typos?.all ?? {})) {
    newContent = newContent.replaceAll(before, after);
  }
  for (const [before, after] of Object.entries(packageConfig.wbfyJson?.typos?.[propName] ?? {})) {
    newContent = newContent.replaceAll(before, after);
  }
  return newContent;
}
