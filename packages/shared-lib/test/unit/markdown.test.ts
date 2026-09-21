import { expect, test } from 'vitest';

import { extractCodeBlocks, extractIfSingleOutermostCodeBlock, extractTopLevelHeadings } from '../../src/markdown.js';

test('extractCodeBlocks reads backtick and tilde fences of any length', () => {
  expect(
    extractCodeBlocks(
      '```TypeScript  title="a.ts"\nconst x = 1;\n```\ntext\n~~~~\ndef f():\n    pass\n\n~~~~\n````markdown\n```py\nprint(1)\n```\n````'
    )
  ).toEqual([
    { language: 'typescript', code: 'const x = 1;', isClosed: true },
    { code: 'def f():\n    pass\n', isClosed: true },
    { language: 'markdown', code: '```py\nprint(1)\n```', isClosed: true },
  ]);
});

test('extractCodeBlocks strips the opening fence indentation and reports an unclosed block', () => {
  expect(
    extractCodeBlocks('1. Step\n   ```js\n   if (a) {\n     b();\n   ```\n```html\n<html>\n``` not a closer')
  ).toEqual([
    { language: 'js', code: 'if (a) {\n  b();', isClosed: true },
    { language: 'html', code: '<html>\n``` not a closer', isClosed: false },
  ]);
});

test('extractCodeBlocks ignores inline code and indented code', () => {
  expect(extractCodeBlocks('Run ```npm test``` now.\n\n    ```\n    indented\n    ```')).toEqual([]);
});

test('extractIfSingleOutermostCodeBlock keeps fences nested without lengthening the outer fence', () => {
  expect(extractIfSingleOutermostCodeBlock('\n```md\n# A\n```js\nx\n```\n```\n')).toBe('# A\n```js\nx\n```');
  expect(extractIfSingleOutermostCodeBlock('~~~\nhello\n~~~')).toBe('hello');
});

test('extractIfSingleOutermostCodeBlock drops text after the first block and reads an unclosed block to the end', () => {
  expect(extractIfSingleOutermostCodeBlock('```json\n{"a":1}\n```\nThat is the answer.')).toBe('{"a":1}');
  expect(extractIfSingleOutermostCodeBlock('```html\n<html>\n<body>')).toBe('<html>\n<body>');
});

test('extractIfSingleOutermostCodeBlock returns the text unless it starts with a fence of an allowed language', () => {
  const prose = 'Here it is:\n```js\nx\n```';
  expect(extractIfSingleOutermostCodeBlock(prose)).toBe(prose);
  expect(extractIfSingleOutermostCodeBlock('```js\nx\n```', ['md', 'markdown'])).toBe('```js\nx\n```');
  expect(extractIfSingleOutermostCodeBlock('```Markdown\n# A\n```', ['md', 'markdown'])).toBe('# A');
});

test('extractTopLevelHeadings splits at the shallowest heading level and keeps the source of each section', () => {
  const markdown = `
## Introduction

- item
- [x] done

### Details

\`\`\`python
# not a heading
print(1)
\`\`\`

## Empty

## \`src/main.py\` File ##

Final content.
`;
  expect(extractTopLevelHeadings(markdown)).toEqual({
    Introduction: '- item\n- [x] done\n\n### Details\n\n```python\n# not a heading\nprint(1)\n```',
    'src/main.py File': 'Final content.',
  });
});

test('extractTopLevelHeadings ignores headings that are not ATX headings at the start of a line', () => {
  const markdown = `# Valid

#Invalid heading without space

Setext
---

- # In a list item

# C#

Content.`;
  expect(extractTopLevelHeadings(markdown)).toEqual({
    Valid: '#Invalid heading without space\n\nSetext\n---\n\n- # In a list item',
    'C#': 'Content.',
  });
});

test('extractTopLevelHeadings reads the headings of a response wrapped in a Markdown code block', () => {
  const markdown = '```markdown\n# Answer\n\n```js\nx\n```\n\n# Reason\n\nBecause.\n```';
  expect(extractTopLevelHeadings(markdown)).toEqual({ Answer: '```js\nx\n```', Reason: 'Because.' });
  expect(extractTopLevelHeadings('```python\n# comment\nx = 1\n```')).toEqual({});
  expect(extractTopLevelHeadings('```md\n# A\nx\n```\n# B\ny')).toEqual({ B: 'y' });
  expect(extractTopLevelHeadings('No headings.')).toEqual({});
});
