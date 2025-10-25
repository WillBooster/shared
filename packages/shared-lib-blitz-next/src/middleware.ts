import type { RequestMiddleware } from 'blitz';

interface BasicAuthMiddlewareOptions {
  password: string;
  realm?: string;
  username: string;
}

/**
 * Timing-safe comparison of two buffers to prevent timing attacks.
 * This implementation works in all JavaScript environments (Node.js, Edge, Browser).
 */
function timingSafeEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) {
    return false;
  }

  let result = 0;
  for (const [i, element] of a.entries()) {
    result |= element ^ (b[i] ?? 0);
  }
  return result === 0;
}

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
      !timingSafeEqual(provided, expected)
    ) {
      response.setHeader('WWW-Authenticate', `Basic realm='${options.realm || 'Secure Area'}'`);
      response.statusCode = 401;
      response.end('Unauthorized');
      return;
    }

    await next();
  };
}
