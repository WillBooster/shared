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
// Blockquotes often cite external text verbatim, which must keep its original spacing. The text of a
// shortcut or collapsed reference link is also its label, which must keep matching its definition,
// and a heading's text determines its anchor, which links in this or other files must keep matching.
const filterRules: TextlintKernelFilterRule[] = [
  {
    ruleId: 'node-types',
    rule: moduleInterop(nodeTypesFilter),
    options: { nodeTypes: ['BlockQuote', 'Header', 'LinkReference'] },
  },
];

// The rule's own patterns, copied from its private `ZenRegExpStr` (v3.0.3), so that files the rule
// cannot change skip the costly Markdown parse. It must stay a superset of the rule's class, or fixes
// are missed.
const zenPattern = String.raw`[、。]|[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]|[\uD840-\uD87F][\uDC00-\uDFFF]|[ぁ-んァ-ヶ]`;
const spaceCandidatePattern = new RegExp(`[A-Za-z0-9][ \u3000](?:${zenPattern})|(?:${zenPattern})[ \u3000][A-Za-z0-9]`);

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
    // `git ls-files --cached` still lists a tracked file deleted from the working tree.
    const text = await fs.readFile(filePath, 'utf8').catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    });
    if (text === undefined || !spaceCandidatePattern.test(text)) continue;
    const output = await fixText(kernel, text, filePath);
    if (output === text) continue;
    if (dryRun) {
      console.info(`Would fix Japanese spacing: ${filePath}`);
    } else {
      await fs.writeFile(filePath, output);
    }
  }
}

// The rule computes each removed space's offset as if every Japanese character were one UTF-16 code
// unit, so after a supplementary CJK character (e.g. 𠮷) it would delete the low surrogate instead.
// Such characters are therefore fixed as a one-unit CJK stand-in absent from the text, which the rule
// treats alike; as it only removes spaces, the stand-ins keep their order and are restored in turn.
const supplementaryCjkPattern = /[\uD840-\uD87F][\uDC00-\uDFFF]/g;

async function fixText(kernel: TextlintKernel, textWithBom: string, filePath: string): Promise<string> {
  // The Markdown processor drops a leading BOM, which would otherwise make every such file look fixed.
  const bom = textWithBom.startsWith('\uFEFF') ? '\uFEFF' : '';
  const text = textWithBom.slice(bom.length);
  const supplementaryCjks = text.match(supplementaryCjkPattern) ?? [];
  let standIn = 0x34_00;
  while (text.includes(String.fromCodePoint(standIn))) standIn++;
  const { output } = await kernel.fixText(text.replaceAll(supplementaryCjkPattern, String.fromCodePoint(standIn)), {
    filePath,
    ext: '.md',
    plugins: [{ pluginId: 'markdown', plugin: { Processor: MarkdownProcessor } }],
    rules,
    filterRules,
  });
  let index = 0;
  return bom + output.replaceAll(String.fromCodePoint(standIn), () => supplementaryCjks[index++] ?? '');
}

async function listMarkdownFiles(rootDirPath: string): Promise<string[]> {
  const listed = await gitLsMarkdownFiles(rootDirPath, ['--exclude-standard']);
  // Unlike `--exclude-from`, this resolves anchored patterns against the ignore file's own directory.
  const ignored = new Set(
    await gitLsMarkdownFiles(rootDirPath, ['--ignored', '--exclude-per-directory=.textlintignore'])
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
