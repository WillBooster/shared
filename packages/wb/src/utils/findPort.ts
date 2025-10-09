import { createServer } from 'node:net';

/**
 * Finds an available port starting from the given port number.
 * @param startPort - The port number to start searching from (default: 3000)
 * @param maxAttempts - Maximum number of ports to try (default: 100)
 * @returns A promise that resolves to an available port number
 */
export async function findAvailablePort(startPort = 3000, maxAttempts = 100): Promise<number> {
  for (let port = startPort; port < startPort + maxAttempts; port++) {
    if (await isPortAvailable(port)) {
      return port;
    }
  }
  throw new Error(`No available port found in range ${startPort}-${startPort + maxAttempts - 1}`);
}

/**
 * Checks if a port is available.
 * @param port - The port number to check
 * @returns A promise that resolves to true if the port is available, false otherwise
 */
async function isPortAvailable(port: number): Promise<boolean> {
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
