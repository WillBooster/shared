import { createServer } from 'node:net';

import type { Project } from '../project.js';

import { killPortProcessImmediatelyAndOnExit } from './process.js';

// The auto-selected range must stay below every default ephemeral-port range (32768+ on Linux,
// 49152+ on macOS) so OS-assigned outgoing connections rarely occupy a preferred port, and above
// well-known service ports such as PostgreSQL's 5432.
const AUTO_PORT_RANGE_START = 20_000;
const AUTO_PORT_RANGE_SIZE = 12_768;
const AUTO_PORT_MAX_PROBE_COUNT = 100;

/**
 * Resolves the port for launching the project's app, storing it in `project.env.PORT`.
 *
 * An explicitly configured PORT (exported or defined in fnox.toml, e.g. for Docker repositories)
 * is used as-is, killing any process occupying it as before. Otherwise a free port is searched
 * upward from a deterministic preferred port derived from the package name and WB_ENV, so
 * repositories need no manually assigned, non-conflicting ports while the local URL stays stable
 * across runs (e.g. for OAuth redirect URIs), and a development server can coexist with an e2e
 * test run of the same repository. NEXT_PUBLIC_BASE_URL is derived from an auto-selected port
 * (unless already defined) so app code and Playwright configs reading it keep working without
 * fnox definitions.
 */
export async function ensurePort(project: Project): Promise<number> {
  if (!project.env.PORT) {
    assertNoPinnedLoopbackBaseUrl(project.env.NEXT_PUBLIC_BASE_URL);
    const port = await findFreePort(computePreferredPort(project));
    project.env.PORT = String(port);
    project.env.NEXT_PUBLIC_BASE_URL ||= `http://localhost:${port}`;
  }
  return await checkAndKillPortProcess(project.env.PORT, project);
}

/** Reads the port `ensurePort` resolved; script builders must not run before it. */
export function getEnsuredPort(project: Project): string {
  const port = project.env.PORT;
  if (!port) throw new Error('PORT is not resolved yet; ensurePort must run first.');
  return port;
}

const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * A pinned localhost NEXT_PUBLIC_BASE_URL cannot match an auto-selected port, so every consumer
 * of the URL would silently point at the wrong server (e.g. Playwright's baseURL during a
 * migration that dropped only PORT); fail fast instead. See docs/expected-repository-rules.md:
 * pinning a localhost URL requires pinning the matching PORT.
 */
function assertNoPinnedLoopbackBaseUrl(baseUrl: string | undefined): void {
  if (!baseUrl) return;
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return;
  }
  if (!LOOPBACK_HOSTNAMES.has(url.hostname)) return;
  throw new Error(
    `NEXT_PUBLIC_BASE_URL (${baseUrl}) points at localhost while PORT is undefined; ` +
      'define the matching PORT, or remove NEXT_PUBLIC_BASE_URL so wb derives both from the auto-selected port.'
  );
}

export function computePreferredPort(project: Project): number {
  return AUTO_PORT_RANGE_START + (hashText(`${project.name}\n${project.env.WB_ENV}`) % AUTO_PORT_RANGE_SIZE);
}

/** FNV-1a (32-bit). */
function hashText(text: string): number {
  let hash = 2_166_136_261;
  for (const character of text) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16_777_619);
  }
  // oxlint-disable-next-line prefer-math-trunc -- `>>> 0` converts to an unsigned 32-bit integer, which Math.trunc does not.
  return hash >>> 0;
}

async function findFreePort(preferredPort: number): Promise<number> {
  for (let offset = 0; offset < AUTO_PORT_MAX_PROBE_COUNT; offset++) {
    // Wrap within the range so a preferred port near the top cannot escape into ephemeral ports.
    const port = AUTO_PORT_RANGE_START + ((preferredPort - AUTO_PORT_RANGE_START + offset) % AUTO_PORT_RANGE_SIZE);
    if (await isPortAvailable(port)) return port;
  }
  throw new Error(`No free port found after probing ${AUTO_PORT_MAX_PROBE_COUNT} ports from ${preferredPort}.`);
}

/**
 * Checks the given port and kills any process using it.
 */
async function checkAndKillPortProcess(rawPort: unknown, project: Project): Promise<number> {
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
      // An unsupported or administratively disabled address family (e.g. IPv6 turned off via
      // sysctl, which yields EADDRNOTAVAIL) cannot hold the port, so treat it as available.
      if (err.code === 'EAFNOSUPPORT' || err.code === 'EADDRNOTAVAIL') {
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
