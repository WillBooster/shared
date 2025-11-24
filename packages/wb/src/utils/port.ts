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
  return new Promise((resolve) => {
    const server = createServer();

    server.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        resolve(false);
      } else {
        resolve(false);
      }
    });

    server.once('listening', () => {
      server.close(() => {
        resolve(true);
      });
    });

    server.listen(port, '127.0.0.1');
  });
}
