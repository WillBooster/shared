import { expect, test } from 'bun:test';

import { toCodeBlock, toTildeCodeBlock } from '../../src/text.js';

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
