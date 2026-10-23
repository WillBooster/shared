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

test('keeps the trailing comment of the element before one appended to an array with a trailing comma', () => {
  const { content } = jsoncUtil.stringifyPreservingTrivia('{\n  "rules": [\n    1, // about 1\n  ],\n}\n', {
    rules: [1, 2],
  });

  expect(content).toBe('{\n  "rules": [\n    1, // about 1\n    2,\n  ],\n}\n');
});

test('removes the trailing comment of a last member on a compact line that continues past its container', () => {
  const { content, keysLosingComments } = jsoncUtil.stringifyPreservingTrivia(
    '{"rules":[1,2 /* why 2 */],"after":1}',
    { rules: [1], after: 1 },
    true
  );

  expect(content).toBe('{"rules":[1],"after":1}');
  expect(keysLosingComments).toEqual(['rules']);
});

test('removes and reports an inline comment that precedes a removed member on its line', () => {
  const { content, keysLosingComments } = jsoncUtil.stringifyPreservingTrivia(
    '{"rules":[1, /* about 2 */ 2, 3]}',
    { rules: [1, 3] },
    true
  );

  expect(content).toBe('{"rules":[1, 3]}');
  expect(keysLosingComments).toEqual(['rules']);
});
