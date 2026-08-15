import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';

import { describe, expect, it } from 'vitest';

import { waitOn } from '../../src/commands/waitOn.js';

describe('waitOn', () => {
  it('detects a listening TCP port', async () => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');

    try {
      const address = server.address();
      if (address === null || typeof address === 'string') throw new Error('TCP server has no port.');
      await waitOn(`tcp:localhost:${address.port}`, { interval: 10, timeout: 1000 });
      await waitOn(`tcp:${address.port}`, { interval: 10, timeout: 1000 });
    } finally {
      await closeServer(server);
    }
  });

  it('polls an HTTP resource until it returns a successful status', async () => {
    let requests = 0;
    const server = http.createServer((_request, response) => {
      requests++;
      response.writeHead(requests === 1 ? 503 : 204);
      response.end();
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');

    try {
      const address = server.address();
      if (address === null || typeof address === 'string') throw new Error('HTTP server has no port.');
      await waitOn(`http://127.0.0.1:${address.port}`, { interval: 10, timeout: 1000 });
      expect(requests).toBeGreaterThanOrEqual(2);
    } finally {
      await closeServer(server);
    }
  });
});

function closeServer(server: net.Server | http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}
