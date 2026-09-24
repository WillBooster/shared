import { expect, test } from 'bun:test';

import { getSafeRedirectPath } from '../../src/url.js';

test('getSafeRedirectPath keeps paths on the same origin', () => {
  expect(getSafeRedirectPath('/practice/a?b=c#d')).toBe('/practice/a?b=c#d');
  expect(getSafeRedirectPath([' /first ', '/second'])).toBe('/first');
  expect(
    getSafeRedirectPath('https://example.com/ja/projects?x=1', { origin: 'https://example.com', fallback: '/ja' })
  ).toBe('/ja/projects?x=1');
});

test('getSafeRedirectPath rejects every absolute URL without an origin', () => {
  for (const value of ['https://redirect.invalid/a', '//redirect.invalid/a', String.raw`/\redirect.invalid/a`]) {
    expect(getSafeRedirectPath(value, { fallback: '/home' })).toBe('/home');
  }
  expect(getSafeRedirectPath('settings?a=1', { fallback: '/home' })).toBe('/settings?a=1');
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
    expect(getSafeRedirectPath(value, { origin: 'https://example.com', fallback: '/home' })).toBe('/home');
  }
});
