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
