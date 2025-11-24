import { createServer } from 'node:net';

import type { Project } from '../project.js';

import { killPortProcessImmediatelyAndOnExit } from './process.js';

/**
 * Checks the given port and kills any process using it.
 * Note wb always requires PORT environment variable.
 */
export async function checkAndKillPortProcess(rawPort: unknown, project: Project): Promise<number> {
  const port = Number(rawPort);
  if (!port) throw new Error(`The given port (${port}) is invalid.`);

  await killPortProcessImmediatelyAndOnExit(port, project);
  return port;
}

/**
 * Checks if a port is available.
 * @param port - The port number to check
 * @returns A promise that resolves to true if the port is available, false otherwise
 */
export async function isPortAvailable(port: number): Promise<boolean> {
  // Check both stacks to catch processes bound only on IPv6 or IPv4.
  for (const host of ['127.0.0.1', '::']) {
    const available = await probePort(host, port);
    if (!available) return false;
  }
  return true;
}

async function probePort(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();

    server.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        resolve(false);
        return;
      }
      if (err.code === 'EAFNOSUPPORT') {
        resolve(true);
        return;
      }
      resolve(false);
    });

    server.once('listening', () => {
      server.close(() => {
        resolve(true);
      });
    });

    server.listen(port, host);
  });
}
