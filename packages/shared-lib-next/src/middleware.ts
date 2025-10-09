import { NextResponse } from 'next/server.js';
import type { NextRequest } from 'next/server.js';

type BasicAuthMiddlewareOptions = {
  username?: string;
  password?: string;
  realm?: string;
};

export function BasicAuthMiddleware(options: BasicAuthMiddlewareOptions): (request: NextRequest) => NextResponse {
  const username = options.username ?? process.env.BASIC_AUTH_USERNAME;
  const password = options.password ?? process.env.BASIC_AUTH_PASSWORD;
  const realm = options.realm ?? process.env.BASIC_AUTH_REALM;

  if (!username && !password) return () => NextResponse.next();

  return (request) => {
    const authorizationHeader = request.headers.get('authorization') ?? '';
    const [type, encodedCredentials] = authorizationHeader.split(' ');
    const credentials = Buffer.from(encodedCredentials ?? '', 'base64').toString();
    const [requestUsername, requestPassword] = credentials.split(':');

    if (
      type?.toLowerCase() !== 'basic' ||
      !requestUsername ||
      !requestPassword ||
      requestUsername !== username ||
      requestPassword !== password
    ) {
      return new NextResponse('Unauthorized', {
        headers: { 'WWW-Authenticate': `Basic realm="${realm || 'Secure Area'}"` },
        status: 401,
      });
    }

    return NextResponse.next();
  };
}
