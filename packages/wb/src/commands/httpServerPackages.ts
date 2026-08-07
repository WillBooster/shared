// @orpc/server counts: an oRPC app serves RPC over HTTP, so its e2e tests need the running
// server (e.g. the Docker container on CI) just like the classic HTTP frameworks.
export const httpServerPackages = ['@orpc/server', 'express', 'fastify', 'elysia', 'hono'];
