import { expect, test } from 'bun:test';

import { omitUndefined } from '../../src/object.js';

test('omitUndefined drops undefined values and types possibly omitted keys as optional', () => {
  const result = omitUndefined({ kept: 'a' as string | undefined, dropped: undefined as string | undefined, count: 0 });
  expect(result).toEqual({ kept: 'a', count: 0 });
  // Type-checked only: a key whose value may be undefined may be missing from the result.
  // @ts-expect-error -- `dropped` is optional
  const readDropped = (): string => result.dropped.toUpperCase();
  expect(readDropped).toBeFunction();
});

test('omitUndefined turns an environment-like record into a Record<string, string>', () => {
  const env: Record<string, string> = omitUndefined({ HOME: '/home/user', UNSET: undefined } as Record<
    string,
    string | undefined
  >);
  expect(env).toEqual({ HOME: '/home/user' });
});
