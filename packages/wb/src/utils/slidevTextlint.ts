import path from 'node:path';

import { load } from '@slidev/parser/fs';
import { TextlintKernel, type TextlintKernelRule } from '@textlint/kernel';
import { moduleInterop } from '@textlint/module-interop';
import { MarkdownProcessor } from '@textlint/textlint-plugin-markdown/lib/src/MarkdownProcessor.js';
import noInvalidControlCharacter from '@textlint-rule/textlint-rule-no-invalid-control-character';
import noHankakuKana from 'textlint-rule-no-hankaku-kana';
import noNfd from 'textlint-rule-no-nfd';
import noZeroWidthSpaces from 'textlint-rule-no-zero-width-spaces';

const rules: TextlintKernelRule[] = [
  { ruleId: 'no-invalid-control-character', rule: moduleInterop(noInvalidControlCharacter) },
  { ruleId: 'no-hankaku-kana', rule: moduleInterop(noHankakuKana) },
  { ruleId: 'no-nfd', rule: moduleInterop(noNfd) },
  { ruleId: 'no-zero-width-spaces', rule: moduleInterop(noZeroWidthSpaces) },
];

export async function lintSlidevText(deckPath: string, workspaceRoot: string): Promise<number> {
  console.info(`Textlint: ${deckPath}`);
  const userRoot = path.dirname(deckPath);
  let data: Awaited<ReturnType<typeof load>>;
  try {
    data = await load({ roots: [userRoot], userRoot, allowedRoots: [workspaceRoot, userRoot] }, deckPath);
  } catch (error) {
    console.error(`${deckPath}: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  const kernel = new TextlintKernel();
  let exitCode = 0;
  for (const file of Object.values(data.markdownFiles)) {
    for (const error of file.errors ?? []) {
      console.error(`${file.filepath}:${error.row + 1}:1: ${error.message}`);
      exitCode = 1;
    }
  }
  const checked = new Set<string>();
  for (const { source } of data.slides) {
    const key = `${source.filepath}:${source.index}`;
    if (checked.has(key)) continue;
    checked.add(key);
    // Keep source lines intact so diagnostics point at the original file, including imported slides.
    const text = source.raw
      .split('\n')
      .slice(source.contentStart - source.start)
      .join('\n');
    const result = await kernel.lintText(text, {
      filePath: source.filepath,
      ext: '.md',
      plugins: [{ pluginId: 'markdown', plugin: { Processor: MarkdownProcessor } }],
      rules,
    });
    for (const message of result.messages) {
      console.error(
        `${source.filepath}:${source.contentStart + message.line}:${message.column}: ${message.message} (${message.ruleId})`
      );
      exitCode = 1;
    }
  }
  return exitCode;
}
