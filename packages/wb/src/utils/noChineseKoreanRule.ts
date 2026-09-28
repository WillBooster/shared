import { findForeignCjkCharactersInJapanese } from '@willbooster/shared-lib/src';
import type { TextlintKernelRule } from '@textlint/kernel';

export const noChineseKorean: TextlintKernelRule['rule'] = ({ getSource, locator, report, RuleError, Syntax }) => ({
  [Syntax.Str](node) {
    const text = getSource(node);
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
  },
});
