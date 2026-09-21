import type { IncomingMessage, ServerResponse } from 'node:http';

import type { MiddlewareNext } from 'blitz';
import { beforeEach, describe, expect, test, mock } from 'bun:test';

import { BasicAuthMiddleware } from '../../src/index.js';

describe('BasicAuthMiddleware', () => {
  const basicAuthMiddleware = BasicAuthMiddleware({ password: 'password', realm: 'realm', username: 'username' });

  let mockRequest: Partial<IncomingMessage> = {};
  let mockResponse: Partial<ServerResponse> = {};
  let mockNext: MiddlewareNext = mock();

  beforeEach(() => {
    mockRequest = {
      headers: {},
    };
    mockResponse = {
      setHeader: mock(),
      end: mock(() => mockResponse as ServerResponse),
    };
    mockNext = mock();
  });

  test('authorized', async () => {
    mockRequest.headers = {
      authorization: `Basic ${Buffer.from('username:password').toString('base64')}`,
    };

    await basicAuthMiddleware(mockRequest as IncomingMessage, mockResponse as ServerResponse, mockNext);

    expect(mockResponse.setHeader).toBeCalledTimes(0);
    expect(mockNext).toBeCalledTimes(1);
  });

  test('incorrect password', async () => {
    mockRequest.headers = {
      authorization: `Basic ${Buffer.from('username:incorrect').toString('base64')}`,
    };

    await basicAuthMiddleware(mockRequest as IncomingMessage, mockResponse as ServerResponse, mockNext);

    expect(mockResponse.setHeader).toBeCalledWith('WWW-Authenticate', "Basic realm='realm'");
    expect(mockResponse.statusCode).toBe(401);
    expect(mockResponse.end).toBeCalledWith('Unauthorized');
    expect(mockNext).toBeCalledTimes(0);
  });

  test('no authorization header', async () => {
    await basicAuthMiddleware(mockRequest as IncomingMessage, mockResponse as ServerResponse, mockNext);

    expect(mockResponse.setHeader).toBeCalledWith('WWW-Authenticate', "Basic realm='realm'");
    expect(mockResponse.statusCode).toBe(401);
    expect(mockResponse.end).toBeCalledWith('Unauthorized');
    expect(mockNext).toBeCalledTimes(0);
  });
});
