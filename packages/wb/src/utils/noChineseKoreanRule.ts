import { findForeignCjkCharactersInJapanese } from '@willbooster/shared-lib/src';
import type { TextlintKernelRule } from '@textlint/kernel';

export const noChineseKorean: TextlintKernelRule['rule'] = ({ getSource, locator, report, RuleError, Syntax }) => {
  const check = (node: Parameters<typeof report>[0], text: string): void => {
    const ranges: [number, number][] = [];
    for (const { 0: char, index } of text.matchAll(/./gu)) {
      if (findForeignCjkCharactersInJapanese(char).length === 0) continue;
      const last = ranges.at(-1);
      if (last?.[1] === index) last[1] += char.length;
      else ranges.push([index, index + char.length]);
    }
    for (const range of ranges) {
      report(
        node,
        new RuleError(`Chinese or Korean text "${text.slice(...range)}" is disallowed.`, {
          padding: locator.range(range),
        })
      );
    }
  };
  return {
    [Syntax.Str](node) {
      check(node, getSource(node));
    },
    // Slidev decks lay out prose in block HTML; blank out comments (speaker notes) and code while keeping offsets.
    [Syntax.Html](node) {
      check(
        node,
        getSource(node).replaceAll(/<!--[\s\S]*?-->|<(code|pre|script|style)\b[\s\S]*?<\/\1\s*>/gi, (nonProse) =>
          ' '.repeat(nonProse.length)
        )
      );
    },
  };
};
