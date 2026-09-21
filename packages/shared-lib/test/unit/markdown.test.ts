import { expect, test } from 'vitest';

import {
  extractCodeBlocks,
  extractIfSingleOutermostCodeBlock,
  extractSections,
  parseMarkdownSections,
} from '../../src/markdown.js';

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

test('extractIfSingleOutermostCodeBlock strips the indentation of an indented outer fence', () => {
  expect(extractIfSingleOutermostCodeBlock('  ```md\n  # A\n    b\n  ```')).toBe('# A\n  b');
  expect(extractSections('\n  ```md\n  # A\n  x\n  ```\n', ['A'])).toEqual({ A: 'x' });
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

test('parseMarkdownSections returns every ATX heading at the start of a line outside fences, with its source', () => {
  const markdown = `
# \`src/main.py\` File ##

- item

## Details

\`\`\`python
# not a heading
\`\`\`

#Invalid heading without space

Setext
---

- # In a list item

# C#
`;
  expect(parseMarkdownSections(markdown)).toEqual([
    {
      depth: 1,
      heading: 'src/main.py File',
      content:
        '- item\n\n## Details\n\n```python\n# not a heading\n```\n\n#Invalid heading without space\n\nSetext\n---\n\n- # In a list item',
    },
    {
      depth: 2,
      heading: 'Details',
      content: '```python\n# not a heading\n```\n\n#Invalid heading without space\n\nSetext\n---\n\n- # In a list item',
    },
    { depth: 1, heading: 'C#', content: '' },
  ]);
});

test('parseMarkdownSections reads the headings of a response wrapped in a Markdown code block', () => {
  expect(parseMarkdownSections('```markdown\n# Answer\n\n```js\nx\n```\n\n# Reason\n\nBecause.\n```')).toEqual([
    { depth: 1, heading: 'Answer', content: '```js\nx\n```' },
    { depth: 1, heading: 'Reason', content: 'Because.' },
  ]);
  expect(parseMarkdownSections('```python\n# comment\nx = 1\n```')).toEqual([]);
});

test('extractSections matches headings despite decorations, numbering, and depth', () => {
  const markdown = `# Hint

## 1. **Mistakes**:

The loop never ends.

## 2.1 \`How to Fix\`

Increment \`i\`.

## Explanation
`;
  expect(extractSections(markdown, ['Mistakes', 'How to Fix', 'Explanation', 'Summary'])).toEqual({
    Mistakes: 'The loop never ends.',
    'How to Fix': 'Increment `i`.',
  });
});

test('extractSections prefers the shallowest heading, then the one written as the name', () => {
  expect(extractSections('## Mistakes\n\nnested\n\n# **Mistakes**\n\ntop', ['Mistakes'])).toEqual({ Mistakes: 'top' });
  expect(extractSections('# A.py\n\nupper\n\n# a.py\n\nlower', ['a.py', 'A.py'])).toEqual({
    'a.py': 'lower',
    'A.py': 'upper',
  });
});

test('extractSections leaves colliding file names missing instead of assigning another file', () => {
  for (const names of [
    ['a.py', 'A.py'],
    ['A.py', 'a.py'],
  ]) {
    expect(extractSections('# A.py\nupper', names)).toEqual({ 'A.py': 'upper' });
    expect(extractSections('# **A.py**\nambiguous', names)).toEqual({});
    expect(extractSections('# **A.py**\nambiguous\n## A.py\nnested', names)).toEqual({});
  }
});

test('extractSections supports arbitrary keys and missing-key validation', () => {
  const names = ['__proto__', 'constructor', 'toString'];
  const sections = extractSections('# __proto__\ncontent', names);
  expect(Object.keys(sections)).toEqual(['__proto__']);
  expect(sections['__proto__']).toBe('content');
  expect(names.filter((name) => !sections[name])).toEqual(['constructor', 'toString']);
});

test('extractSections distinguishes numeric file names and decimal titles from numbering', () => {
  expect(extractSections('# 1. 1.py\nfirst\n# 2. **2.py**\nsecond', ['1.py', '2.py'])).toEqual({
    '1.py': 'first',
    '2.py': 'second',
  });
  expect(extractSections('# 2.1\nother section', ['1.1'])).toEqual({});
});
