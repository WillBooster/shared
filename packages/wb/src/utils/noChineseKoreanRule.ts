import { findForeignCjkCharactersInJapanese } from '@willbooster/shared-lib/src';
import type { TextlintKernelRule } from '@textlint/kernel';

// Checks the whole source except code and HTML comments (speaker notes), since visible slide text also lives in
// block HTML, image alt text, and other nodes that a per-node-type visitor would miss.
export const noChineseKorean: TextlintKernelRule['rule'] = ({ getSource, locator, report, RuleError, Syntax }) => {
  const codeRanges: (readonly [number, number])[] = [];
  return {
    [Syntax.Code](node) {
      codeRanges.push(node.range);
    },
    [Syntax.CodeBlock](node) {
      codeRanges.push(node.range);
    },
    [Syntax.DocumentExit](node) {
      let text = getSource(node);
      for (const [start, end] of codeRanges) {
        text = text.slice(0, start) + ' '.repeat(end - start) + text.slice(end);
      }
      text = text.replaceAll(/<!--[\s\S]*?-->|<(code|pre|script|style)\b[\s\S]*?<\/\1\s*>/gi, (nonProse) =>
        ' '.repeat(nonProse.length)
      );
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
  };
};
