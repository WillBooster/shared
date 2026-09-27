import { expect, test } from 'bun:test';

import { getFormString, parseBearerToken } from '../../src/http.js';

test('parseBearerToken accepts the scheme in any case and rejects other schemes and malformed values', () => {
  expect(parseBearerToken('Bearer abc.DEF-123_~+/==')).toBe('abc.DEF-123_~+/==');
  expect(parseBearerToken('bearer  token ')).toBe('token');
  expect(parseBearerToken('Basic dXNlcjpwYXNz')).toBeUndefined();
  expect(parseBearerToken('Bearer a b')).toBeUndefined();
  expect(parseBearerToken('Bearer ')).toBeUndefined();
  expect(parseBearerToken('Bearer \u212A')).toBeUndefined();
  expect(parseBearerToken(undefined)).toBeUndefined();
});

test('getFormString returns text fields only', () => {
  const formData = new FormData();
  formData.set('name', 'value');
  formData.set('file', new Blob(['content']), 'file.txt');
  expect(getFormString(formData, 'name')).toBe('value');
  expect(getFormString(formData, 'file')).toBeUndefined();
  expect(getFormString(formData, 'missing')).toBeUndefined();
});
