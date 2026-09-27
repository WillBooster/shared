import { expect, test } from 'bun:test';

import { omitUndefined } from '../../src/object.js';

test('omitUndefined drops undefined values and types possibly omitted keys as optional', () => {
  const result = omitUndefined({ kept: 'a' as string | undefined, dropped: undefined as string | undefined, count: 0 });
  expect(result).toStrictEqual({ kept: 'a', count: 0 });
  // @ts-expect-error -- a key whose value may be undefined may be missing from the result
  const dropped: string = result.dropped;
  expect(dropped).toBeUndefined();
});

test('omitUndefined copies a `__proto__` key as an own property without changing the prototype', () => {
  const result = omitUndefined(JSON.parse('{"__proto__":{"admin":true},"x":1}') as Record<string, unknown>);
  expect(Object.keys(result)).toEqual(['__proto__', 'x']);
  expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
  expect((result as { admin?: boolean }).admin).toBeUndefined();
});

test('omitUndefined turns an environment-like record into a Record<string, string>', () => {
  const env: Record<string, string> = omitUndefined({ HOME: '/home/user', UNSET: undefined } as Record<
    string,
    string | undefined
  >);
  expect(env).toStrictEqual({ HOME: '/home/user' });
});

test('omitUndefined rejects arrays and class instances and leaves symbol keys out of its result', () => {
  // @ts-expect-error -- the copy is a plain object, not an array
  omitUndefined([1, undefined]);
  // @ts-expect-error -- the copy has no `Date` methods
  omitUndefined(new Date());
  const key = Symbol('key');
  const result = omitUndefined({ [key]: 'value', name: 'a' });
  // @ts-expect-error -- symbol keys are not copied
  const symbolValue: string = result[key];
  expect(symbolValue).toBeUndefined();
  expect(result).toStrictEqual({ name: 'a' });
});
