import fs from 'node:fs/promises';
import path from 'node:path';

import { spawnAsync } from '@willbooster/shared-lib-node/src';
import { TextlintKernel, type TextlintKernelFilterRule, type TextlintKernelRule } from '@textlint/kernel';
import { moduleInterop } from '@textlint/module-interop';
// The pinned package has no named Processor export; its default import also fails NodeNext typing.
import { MarkdownProcessor } from '@textlint/textlint-plugin-markdown/lib/src/MarkdownProcessor.js';
import nodeTypesFilter from 'textlint-filter-rule-node-types';
import jaSpaceBetweenHalfAndFullWidth from 'textlint-rule-ja-space-between-half-and-full-width';

const rules: TextlintKernelRule[] = [
  {
    ruleId: 'ja-space-between-half-and-full-width',
    rule: moduleInterop(jaSpaceBetweenHalfAndFullWidth),
    options: { space: 'never', lintStyledNode: true },
  },
];
// Blockquotes often cite external text verbatim, which must keep its original spacing.
const filterRules: TextlintKernelFilterRule[] = [
  { ruleId: 'node-types', rule: moduleInterop(nodeTypesFilter), options: { nodeTypes: ['BlockQuote'] } },
];

/**
 * Removes spaces between Japanese and half-width characters in the Markdown files under `rootDirPath`
 * that Git does not ignore and `.textlintignore` does not list, restricted to `targetPaths` (files or
 * directories) when given.
 */
export async function fixJapaneseSpacing(
  rootDirPath: string,
  targetPaths: string[] | undefined,
  dryRun: boolean | undefined
): Promise<void> {
  const filePaths = filterTargetPaths(await listMarkdownFiles(rootDirPath), targetPaths);
  const kernel = new TextlintKernel();
  for (const filePath of filePaths) {
    const text = await fs.readFile(filePath, 'utf8');
    const { output } = await kernel.fixText(text, {
      filePath,
      ext: '.md',
      plugins: [{ pluginId: 'markdown', plugin: { Processor: MarkdownProcessor } }],
      rules,
      filterRules,
    });
    if (output === text) continue;
    if (dryRun) {
      console.info(`Would fix Japanese spacing: ${filePath}`);
    } else {
      await fs.writeFile(filePath, output);
    }
  }
}

async function listMarkdownFiles(rootDirPath: string): Promise<string[]> {
  const listed = await gitLsMarkdownFiles(rootDirPath, ['--exclude-standard']);
  const ignoreFilePath = path.join(rootDirPath, '.textlintignore');
  const ignored = new Set(
    (await fs.stat(ignoreFilePath).catch(() => {}))
      ? await gitLsMarkdownFiles(rootDirPath, ['--ignored', `--exclude-from=${ignoreFilePath}`])
      : []
  );
  return listed
    .filter((filePath) => !ignored.has(filePath))
    .map((filePath) => path.join(rootDirPath, filePath))
    .filter((filePath) => !isInTestFixtures(filePath));
}

async function gitLsMarkdownFiles(rootDirPath: string, options: string[]): Promise<string[]> {
  const { status, stdout } = await spawnAsync(
    'git',
    ['ls-files', '-z', '--cached', '--others', ...options, '--', '*.md'],
    { cwd: rootDirPath }
  );
  // Outside a Git repository, there is no file list to trust.
  return status === 0 ? stdout.split('\0').filter(Boolean) : [];
}

function filterTargetPaths(filePaths: string[], targetPaths: string[] | undefined): string[] {
  if (!targetPaths) return filePaths;
  const resolvedTargets = targetPaths.map((targetPath) => path.resolve(targetPath));
  return filePaths.filter((filePath) =>
    resolvedTargets.some((target) => filePath === target || filePath.startsWith(`${target}/`))
  );
}

export function isInTestFixtures(filePath: string): boolean {
  return (
    filePath.endsWith('/test/fixtures') ||
    filePath.includes('/test/fixtures/') ||
    filePath.endsWith('/test-fixtures') ||
    filePath.includes('/test-fixtures/')
  );
}
