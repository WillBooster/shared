import { expect, test } from 'bun:test';

import { getSafeRedirectPath } from '../../src/url.js';

const origin = 'https://example.com';

test('getSafeRedirectPath keeps paths on the same origin', () => {
  expect(getSafeRedirectPath('/practice/a?b=c#d', { origin })).toBe('/practice/a?b=c#d');
  expect(getSafeRedirectPath('settings', { origin })).toBe('/settings');
  expect(getSafeRedirectPath([' /first ', '/second'], { origin })).toBe('/first');
  expect(getSafeRedirectPath('https://example.com/ja/projects?x=1', { origin, fallback: '/ja' })).toBe(
    '/ja/projects?x=1'
  );
});

test('getSafeRedirectPath rejects values that browsers resolve to another origin', () => {
  for (const value of [
    'https://evil.example',
    '//evil.example',
    String.raw`/\evil.example`,
    '/\t/evil.example',
    '/\n/evil.example',
    '/.//evil.example',
    'javascript:alert(1)',
    'blob:https://example.com/id',
    'https://example.com.evil.example/',
    '',
    [],
    // oxlint-disable-next-line unicorn/no-null -- URLSearchParams.get() returns null for a missing callback URL.
    null,
    undefined,
  ]) {
    expect(getSafeRedirectPath(value, { origin, fallback: '/home' })).toBe('/home');
  }
});

test('getSafeRedirectPath throws for an unparsable origin instead of rejecting every value', () => {
  expect(() => getSafeRedirectPath('/a', { origin: 'example.com' })).toThrow(TypeError);
});
