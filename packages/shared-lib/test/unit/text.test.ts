import { expect, test } from 'bun:test';

import { escapeHtml, toCodeBlock, toTildeCodeBlock, truncate } from '../../src/text.js';

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
  expect(() => truncate('abcdef', 2, '...')).toThrow(RangeError);
});
