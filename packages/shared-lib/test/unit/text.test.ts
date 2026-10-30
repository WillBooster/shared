import { expect, test } from 'bun:test';

import {
  escapeHtml,
  getTildeFence,
  toCodeBlock,
  toTildeCodeBlock,
  truncate,
  unwrapFencedReply,
} from '../../src/text.js';

test('toTildeCodeBlock adds a language only when given and ends the text with a newline', () => {
  expect(toTildeCodeBlock('echo hi')).toBe('~~~\necho hi\n~~~');
  expect(toTildeCodeBlock('echo hi\n', 'sh')).toBe('~~~sh\necho hi\n~~~');
});

test('toTildeCodeBlock uses a fence longer than any tilde run in the text', () => {
  expect(toTildeCodeBlock('~~ x')).toBe('~~~\n~~ x\n~~~');
  expect(toTildeCodeBlock('~~~ts\ncode\n~~~~~', 'md')).toBe('~~~~~~md\n~~~ts\ncode\n~~~~~\n~~~~~~');
});

test('toCodeBlock uses a fence longer than any backtick run in the text', () => {
  expect(toCodeBlock('echo hi', 'sh')).toBe('```sh\necho hi\n```');
  expect(toCodeBlock('```ts\ncode\n````')).toBe('`````\n```ts\ncode\n````\n`````');
});

test('escapeHtml escapes every special character, including adjacent and leading or trailing ones', () => {
  expect(escapeHtml(`<a href="x" title='y'>&</a>`)).toBe(
    '&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;'
  );
  expect(escapeHtml('plain text')).toBe('plain text');
  expect(escapeHtml('a&&b')).toBe('a&amp;&amp;b');
});

test('truncate keeps the result within maxLength including the ellipsis without splitting a surrogate pair', () => {
  expect(truncate('abcdef', 6)).toBe('abcdef');
  expect(truncate('abcdef', 4)).toBe('abc…');
  expect(truncate('abcdef', 5, '...')).toBe('ab...');
  expect(truncate('a😀bc', 3)).toBe('a…');
  expect(truncate('a\uD83Dbc', 3)).toBe('a…');
  expect(() => truncate('abcdef', 2, '...')).toThrow(RangeError);
});

const fencedDocument = '# Title\n\n~~~ts\nconst x = 1;\n~~~\n\n```sh\nrun\n```';
const documentFence = getTildeFence(fencedDocument);

test('unwrapFencedReply returns the document from the exact wrapper it was sent in, labeled or not', () => {
  expect(documentFence).toBe('~~~~');
  expect(unwrapFencedReply(toTildeCodeBlock(fencedDocument, 'md'), documentFence)).toBe(fencedDocument);
  expect(unwrapFencedReply(toTildeCodeBlock(fencedDocument, 'markdown'), documentFence)).toBe(fencedDocument);
  expect(unwrapFencedReply(toTildeCodeBlock(fencedDocument), documentFence)).toBe(fencedDocument);
  expect(unwrapFencedReply(`~~~~ md title="x"\n${fencedDocument}\n~~~~`, documentFence)).toBe(fencedDocument);
});

test('unwrapFencedReply ignores a BOM, CRLF, trailing spaces on fence lines, and blank lines around the wrapper', () => {
  expect(unwrapFencedReply('\uFEFF~~~~md\r\n# A\r\nb\r\n~~~~\r\n', '~~~~')).toBe('# A\nb');
  expect(unwrapFencedReply('~~~~md  \n# A  \n~~~~ \t', '~~~~')).toBe('# A  ');
  expect(unwrapFencedReply('\n\n~~~~md\n# A\n~~~~\n\n', '~~~~')).toBe('# A');
  expect(unwrapFencedReply('\n \n```md \n# A\n``` \n\n', '~~~')).toBe('# A');
});

test('unwrapFencedReply drops a preamble and a postamble around a tilde wrapper', () => {
  const reply = `Here is the translation:\n\n${toTildeCodeBlock(fencedDocument, 'md')}\n\nLet me know if ~~~ needs changes.`;
  expect(unwrapFencedReply(reply, documentFence)).toBe(fencedDocument);
});

test('unwrapFencedReply accepts longer tilde fences when the closing fence is at least as long as the opening one', () => {
  expect(unwrapFencedReply(`~~~~~md\n${fencedDocument}\n~~~~~`, documentFence)).toBe(fencedDocument);
  expect(unwrapFencedReply(`~~~~md\n${fencedDocument}\n~~~~~~`, documentFence)).toBe(fencedDocument);
  expect(unwrapFencedReply(`~~~~~md\n${fencedDocument}\n~~~~`, documentFence)).toBeUndefined();
});

test('unwrapFencedReply rejects a tilde wrapper shorter than the sent fence', () => {
  expect(unwrapFencedReply(`~~~md\n${fencedDocument}\n~~~`, documentFence)).toBeUndefined();
});

test('unwrapFencedReply accepts a backtick wrapper only when nothing inside could close it', () => {
  expect(unwrapFencedReply(`\`\`\`\`md\n${fencedDocument}\n\`\`\`\``, documentFence)).toBe(fencedDocument);
  expect(unwrapFencedReply(`\`\`\`\`\n${fencedDocument}\n\`\`\`\`\``, documentFence)).toBe(fencedDocument);
  expect(unwrapFencedReply(`\`\`\`\`Markdown\n${fencedDocument}\n\`\`\`\``, documentFence)).toBe(fencedDocument);
  expect(unwrapFencedReply(`\`\`\`md\n${fencedDocument}\n\`\`\``, documentFence)).toBeUndefined();
  expect(unwrapFencedReply(`Here it is:\n\`\`\`\`md\n${fencedDocument}\n\`\`\`\``, documentFence)).toBeUndefined();
  expect(unwrapFencedReply(`\`\`\`\`md\n${fencedDocument}\n\`\`\`\`\nDone.`, documentFence)).toBeUndefined();
  expect(unwrapFencedReply('```java\nclass A {}\n```', '~~~')).toBeUndefined();
});

test('unwrapFencedReply rejects a tilde wrapper opening inside a backtick block', () => {
  const tildeFenced = '# Title\n\n~~~ts\nconst x = 1;\n~~~\n\n# Next';
  expect(unwrapFencedReply(`\`\`\`md\n${tildeFenced}\n\`\`\``, '~~~')).toBeUndefined();
  expect(unwrapFencedReply(`Here it is:\n\`\`\`md\n${tildeFenced}\n\`\`\`\nHope that helps.`, '~~~')).toBeUndefined();
  expect(unwrapFencedReply('````md\n~~~~md\n# A\n~~~~\n````', '~~~~')).toBeUndefined();
  expect(unwrapFencedReply('Like this:\n```sh\nrun\n```\n~~~md\n# A\n~~~', '~~~')).toBe('# A');
});

test('unwrapFencedReply rejects a reply without a closed wrapper', () => {
  expect(unwrapFencedReply(fencedDocument, documentFence)).toBeUndefined();
  expect(unwrapFencedReply('```sh\nrun\n```\n\n# Title', '~~~')).toBeUndefined();
  expect(unwrapFencedReply(`~~~~md\n${fencedDocument}`, documentFence)).toBeUndefined();
  expect(unwrapFencedReply(`\`\`\`\`md\n${fencedDocument}`, documentFence)).toBeUndefined();
});
