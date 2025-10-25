import { NextResponse } from 'next/server.js';
import type { NextRequest } from 'next/server.js';

interface BasicAuthMiddlewareOptions {
  username?: string;
  password?: string;
  realm?: string;
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

export function BasicAuthMiddleware(options: BasicAuthMiddlewareOptions): (request: NextRequest) => NextResponse {
  const username = options.username ?? process.env.BASIC_AUTH_USERNAME;
  const password = options.password ?? process.env.BASIC_AUTH_PASSWORD;
  const realm = options.realm ?? process.env.BASIC_AUTH_REALM;

  if (!username && !password) return () => NextResponse.next();

  return (request) => {
    const authorizationHeader = request.headers.get('authorization') ?? '';
    const [type, encodedCredentials] = authorizationHeader.split(' ');
    const expected = Buffer.from(`${username}:${password}`);
    const provided = Buffer.from(encodedCredentials ?? '', 'base64');

    if (
      type?.toLowerCase() !== 'basic' ||
      provided.length === 0 ||
      expected.length !== provided.length ||
      !timingSafeEqual(provided, expected)
    ) {
      return new NextResponse('Unauthorized', {
        headers: { 'WWW-Authenticate': `Basic realm="${realm || 'Secure Area'}"` },
        status: 401,
      });
    }

    return NextResponse.next();
  };
}
