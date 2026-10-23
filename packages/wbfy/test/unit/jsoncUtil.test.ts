import { expect, test } from 'bun:test';

import { jsoncUtil } from '../../src/utils/jsoncUtil.js';

test('removes the only property of a nested object written with trailing commas', () => {
  const { content } = jsoncUtil.stringifyPreservingTrivia(
    '{\n  // keep\n  "a": {\n    "b": 1, // obsolete\n  },\n}\n',
    { a: {} },
    true
  );

  expect(content).toContain('// keep');
  expect(jsoncUtil.parseObjectIgnoringError(content)).toEqual({ a: {} });
});

test('keeps the comments of neighbouring properties when removing an object property', () => {
  const { content, keysLosingComments } = jsoncUtil.stringifyPreservingTrivia(
    '{\n  "a": {\n    "b": 1, // about b\n    // about c\n    "c": 2\n  }\n}\n',
    { a: { c: 2 } },
    true
  );

  expect(content).toBe('{\n  "a": {\n    // about c\n    "c": 2\n  }\n}\n');
  expect(keysLosingComments).toEqual(['a']);
});

test('removes and reports the comments around a removed array element', () => {
  const { content, keysLosingComments } = jsoncUtil.stringifyPreservingTrivia(
    '{"rules":[\n  /* about 1\n   * detail\n   */\n  1, // more about 1\n  2 /* about 2 */,\n  3\n]}',
    { rules: [2, 3] },
    true
  );

  expect(content).toBe('{"rules":[\n  2 /* about 2 */,\n  3\n]}');
  expect(keysLosingComments).toEqual(['rules']);
});

test('keeps a comment that documents the next member on the same line as the removed one', () => {
  const { content } = jsoncUtil.stringifyPreservingTrivia(
    '{\n  "o": {\n    "a": 1, /* about b */ "b": 2\n  }\n}\n',
    { o: { b: 2 } },
    true
  );

  expect(content).toBe('{\n  "o": {\n    /* about b */ "b": 2\n  }\n}\n');
});
