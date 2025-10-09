import crypto from 'node:crypto';

import type { RequestMiddleware } from 'blitz';

type BasicAuthMiddlewareOptions = {
  password: string;
  realm?: string;
  username: string;
};

export function BasicAuthMiddleware(options: BasicAuthMiddlewareOptions): RequestMiddleware {
  return async (request, response, next) => {
    const authorizationHeader = request.headers.authorization ?? '';
    const [type, encodedCredentials] = authorizationHeader.split(' ');
    const expected = Buffer.from(`${options.username}:${options.password}`);
    const provided = Buffer.from(encodedCredentials ?? '', 'base64');

    if (
      type?.toLowerCase() !== 'basic' ||
      provided.length === 0 ||
      expected.length !== provided.length ||
      !crypto.timingSafeEqual(provided, expected)
    ) {
      response.setHeader('WWW-Authenticate', `Basic realm='${options.realm || 'Secure Area'}'`);
      response.statusCode = 401;
      response.end('Unauthorized');
      return;
    }

    await next();
  };
}
