import path from 'node:path';

import { globIgnore } from '@willbooster/shared-lib-node/src';
import fg from 'fast-glob';

import { isReusableWorkflowsRepo } from '../generators/workflow.js';
import { logger } from '../logger.js';
import { options } from '../options.js';
import type { PackageConfig } from '../packageConfig.js';
import { fsUtil } from '../utils/fsUtil.js';
import { runAllInPool } from '../utils/promisePool.js';
import { getWorkspaceDirPatterns } from '../utils/workspaceUtil.js';

export async function fixTypos(packageConfig: PackageConfig): Promise<void> {
  return logger.functionIgnoringException('fixTypos', async () => {
    if (isReusableWorkflowsRepo(packageConfig.repository)) return;

    const dirPath = packageConfig.dirPath;
    const docFiles = await fg.glob('**/*.md', { dot: true, cwd: dirPath, ignore: globIgnore });
    if (options.isVerbose) {
      console.info(`Found ${docFiles.length} markdown files in ${dirPath}`);
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

    const textBasedFiles = await fg.glob('**/*.{csv,htm,html,tsv,xml,yaml,yml}', {
      dot: true,
      cwd: dirPath,
      ignore: globIgnore,
    });
    if (options.isVerbose) {
      console.info(`Found ${textBasedFiles.length} text-based files in ${dirPath}`);
    }

    await runAllInPool([
      ...docFiles.map((file) => fixFile(path.join(dirPath, file), fixTyposInText, packageConfig, 'doc')),
      ...tsFiles.map((file) => fixFile(path.join(dirPath, file), fixTyposInCode, packageConfig, 'ts')),
      ...textBasedFiles.map((file) => fixFile(path.join(dirPath, file), fixTyposInText, packageConfig, 'text')),
    ]);
  });
}

function fixFile(
  filePath: string,
  fixTypos: (content: string) => string,
  packageConfig: PackageConfig,
  propName: 'doc' | 'ts' | 'text'
): () => Promise<void> {
  return async () => {
    const content = await fsUtil.readFileIfExists(filePath);
    if (content === undefined) return;
    const newContent = replaceWithConfig(fixTypos(content), packageConfig, propName);
    if (content !== newContent) {
      await fsUtil.generateFile(filePath, newContent);
    }
  };
}

export function fixTyposInText(content: string): string {
  return content
    .replaceAll(/\bc\.f\.(?=\s|$)/g, 'cf.')
    .replaceAll(/\beg\.(?=\s|$)/g, 'e.g.')
    .replaceAll(/\bie\.(?=\s)/g, 'i.e.');
}

export function fixTyposInCode(content: string): string {
  return (
    content
      .replaceAll(/\/\*[\s\S]*?\*\//g, (comment) => fixTyposInText(comment))
      // The word boundary and trailing-whitespace guard keep words merely ending in the
      // abbreviation letters (e.g. "cookie.", "leg.") intact.
      .replaceAll(/(^|\s)\/\/(.*?)\bc\.f\.(?=\s|$)/g, '$1//$2cf.')
      .replaceAll(/(^|\s)\/\/(.*?)\beg\.(?=\s|$)/g, '$1//$2e.g.')
      .replaceAll(/(^|\s)\/\/(.*?)\bie\.(?=\s|$)/g, '$1//$2i.e.')
  );
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
