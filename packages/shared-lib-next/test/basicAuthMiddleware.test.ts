import { NextRequest } from 'next/server.js';
import { describe, expect, test } from 'vitest';

import { BasicAuthMiddleware } from '../src/index.js';

describe('BasicAuthMiddleware', () => {
  const basicAuthMiddleware = BasicAuthMiddleware({ password: 'password', realm: 'realm', username: 'username' });

  test('authorized', () => {
    const request = new NextRequest('http://127.0.0.1', {
      headers: { authorization: `Basic ${Buffer.from('username:password').toString('base64')}` },
    });

    const response = basicAuthMiddleware(request);

    expect(response.ok).toBe(true);
  });

  test('incorrect password', async () => {
    const request = new NextRequest('http://127.0.0.1', {
      headers: { authorization: `Basic ${Buffer.from('username:incorrect').toString('base64')}` },
    });

    const response = basicAuthMiddleware(request);

    expect(response.status).toBe(401);
    expect(response.headers.get('WWW-Authenticate')).toBe('Basic realm="realm"');
    expect(await response.text()).toBe('Unauthorized');
  });

  test('no authorization header', async () => {
    const request = new NextRequest('http://127.0.0.1');

    const response = basicAuthMiddleware(request);

    expect(response.status).toBe(401);
    expect(response.headers.get('WWW-Authenticate')).toBe('Basic realm="realm"');
    expect(await response.text()).toBe('Unauthorized');
  });

  test('auth disabled', () => {
    const middleware = BasicAuthMiddleware({});
    const request = new NextRequest('http://127.0.0.1');

    const response = middleware(request);

    expect(response.status).toBe(200);
  });
});
