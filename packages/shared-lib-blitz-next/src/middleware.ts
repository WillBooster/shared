import type { RequestMiddleware } from 'blitz';

interface BasicAuthMiddlewareOptions {
  password: string;
  realm?: string;
  username: string;
}

export function BasicAuthMiddleware(options: BasicAuthMiddlewareOptions): RequestMiddleware {
  return async (request, response, next) => {
    const authorizationHeader = request.headers.authorization ?? '';
    const [type, encodedCredentials] = authorizationHeader.split(' ');
    const credentials = Buffer.from(encodedCredentials ?? '', 'base64').toString();
    const [requestUsername, requestPassword] = credentials.split(':');

    if (
      type !== 'Basic' ||
      !requestUsername ||
      !requestPassword ||
      requestUsername !== options.username ||
      requestPassword !== options.password
    ) {
      response.setHeader('WWW-Authenticate', `Basic realm='${options.realm ?? 'Secure Area'}'`);
      response.statusCode = 401;
      response.end('Unauthorized');
      return;
    }

    await next();
  };
}
