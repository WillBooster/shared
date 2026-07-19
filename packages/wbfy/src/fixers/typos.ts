import path from 'node:path';

import fg from 'fast-glob';

import { isReusableWorkflowsRepo } from '../generators/workflow.js';
import { logger } from '../logger.js';
import { options } from '../options.js';
import type { PackageConfig } from '../packageConfig.js';
import { fsUtil } from '../utils/fsUtil.js';
import { globIgnore } from '../utils/globUtil.js';
import { promisePool } from '../utils/promisePool.js';
import { getWorkspaceDirPatterns } from '../utils/workspaceUtil.js';

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
      void promisePool.run(async () => {
        const content = await fsUtil.readFileIfExists(filePath);
        if (content === undefined) return;
        let newContent = fixTyposInText(content);
        newContent = replaceWithConfig(newContent, packageConfig, 'doc');
        if (content !== newContent) {
          await fsUtil.generateFile(filePath, newContent);
        }
      });
    }

    // fixTypos runs once on the root config, so this glob set must cover every declared workspace
    // layout (e.g. apps/*), not just the conventional packages/* directory — while honoring
    // declared negations (e.g. `!apps/excluded`), whose sources are not part of the monorepo.
    const workspaceDirPatterns = getWorkspaceDirPatterns(packageConfig);
    const tsFiles = await fg.glob(
      [
        '{app,src,test,scripts}/**/*.{cjs,mjs,js,jsx,cts,mts,ts,tsx}',
        'packages/**/{app,src,test,scripts}/**/*.{cjs,mjs,js,jsx,cts,mts,ts,tsx}',
        ...workspaceDirPatterns.includes.map(
          (dirPattern) => `${dirPattern}/**/{app,src,test,scripts}/**/*.{cjs,mjs,js,jsx,cts,mts,ts,tsx}`
        ),
      ],
      {
        dot: true,
        cwd: dirPath,
        ignore: [...globIgnore, ...workspaceDirPatterns.excludes.map((dirPattern) => `${dirPattern}/**`)],
      }
    );
    if (options.isVerbose) {
      console.info(`Found ${tsFiles.length} TypeScript files in ${dirPath}`);
    }
    for (const tsFile of tsFiles) {
      const filePath = path.join(dirPath, tsFile);
      void promisePool.run(async () => {
        const oldContent = await fsUtil.readFileIfExists(filePath);
        if (oldContent === undefined) return;
        let newContent = fixTyposInCode(oldContent);
        newContent = replaceWithConfig(newContent, packageConfig, 'ts');

        if (oldContent !== newContent) {
          await fsUtil.generateFile(filePath, newContent);
        }
      });
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
      void promisePool.run(async () => {
        const oldContent = await fsUtil.readFileIfExists(filePath);
        if (oldContent === undefined) return;
        let newContent = fixTyposInText(oldContent);
        newContent = replaceWithConfig(newContent, packageConfig, 'text');

        if (oldContent !== newContent) {
          await fsUtil.generateFile(filePath, newContent);
        }
      });
    }

    await promisePool.promiseAll();
  });
}

export function fixTyposInText(content: string): string {
  return content
    .replaceAll(/\bc\.f\.(?=\s|$)/g, 'cf.')
    .replaceAll(/\beg\.(?=\s|$)/g, 'e.g.')
    .replaceAll(/\bie\.(?=\s)/g, 'i.e.');
}

function fixTyposInCode(content: string): string {
  return content
    .replaceAll(/\/\*[\s\S]*?\*\//g, (comment) => fixTyposInText(comment))
    .replaceAll(/(^|\s)\/\/(.*?)c\.f\./g, '$1//$2cf.')
    .replaceAll(/(^|\s)\/\/(.*?)eg\./g, '$1//$2e.g.')
    .replaceAll(/(^|\s)\/\/(.*?)ie\./g, '$1//$2i.e.');
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
