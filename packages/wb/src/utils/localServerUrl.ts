import fs from 'node:fs';
import path from 'node:path';

import type { Project } from '../project.js';

import { isPortAvailable } from './port.js';

// Only local environments serve a URL that cannot be known ahead of time; staging and production
// always carry a fixed, deployed URL that a local file must never shadow.
const LOCAL_SERVER_WB_ENVS = new Set(['development', 'test']);
const WB_DIRECTORY_NAME = '.wb';

/**
 * Publishes the URL of the server `wb start` / `wb test` is about to serve into
 * `.wb/server-<WB_ENV>.url`, removing it when this process exits.
 *
 * Commands that merely CONSUME the app (e.g. `wb run scripts/importProblems.ts`) cannot compute an
 * auto-selected port: the selection returns a FREE port, i.e. never the one a running server
 * occupies. Without this file, a repository whose scripts must name the local server would have to
 * pin PORT for that reason alone. The file holds the bare URL so any language can read it.
 */
export function publishLocalServerUrl(project: Project, baseUrl: string): void {
  const filePath = buildLocalServerUrlFilePath(project.dirPath, project.env.WB_ENV);
  if (!filePath) return;

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${baseUrl}\n`);
  // Only the synchronous 'exit' event is hooked: a signal listener would suppress Node's default
  // termination, and a file surviving a crash is harmless anyway because readLocalServerUrl
  // discards one whose port serves nothing.
  process.on('exit', () => {
    try {
      fs.rmSync(filePath, { force: true });
    } catch {
      // A concurrently removed file (e.g. another process wiping .wb) must not break the exit.
    }
  });
}

/**
 * Reads the URL published by a local server that is still running, searching upward from `cwd` so
 * a script started at a monorepo root finds the server of a package (and vice versa). Returns
 * undefined when no server runs; a file left behind by a crash is detected by probing its port.
 */
export async function readLocalServerUrl(cwd: string, wbEnv: string | undefined): Promise<string | undefined> {
  const filePath = findLocalServerUrlFilePath(cwd, wbEnv);
  if (!filePath) return undefined;

  let port: number;
  let baseUrl: string;
  try {
    baseUrl = fs.readFileSync(filePath, 'utf8').trim();
    port = Number(new URL(baseUrl).port);
  } catch {
    return undefined;
  }
  if (!port) return undefined;
  if (await isPortAvailable(port)) {
    fs.rmSync(filePath, { force: true });
    return undefined;
  }
  return baseUrl;
}

/**
 * Lets a consuming command reach the running local server without a pinned PORT. An explicitly
 * configured value always wins: the file answers only what nothing else could have.
 */
export async function applyLocalServerUrl(cwd: string, env: NodeJS.ProcessEnv): Promise<void> {
  if (env.NEXT_PUBLIC_BASE_URL) return;

  const baseUrl = await readLocalServerUrl(cwd, env.WB_ENV);
  if (baseUrl) env.NEXT_PUBLIC_BASE_URL = baseUrl;
}

function findLocalServerUrlFilePath(cwd: string, wbEnv: string | undefined): string | undefined {
  for (let currentDirPath = path.resolve(cwd); ; currentDirPath = path.dirname(currentDirPath)) {
    const filePath = buildLocalServerUrlFilePath(currentDirPath, wbEnv);
    if (filePath && fs.existsSync(filePath)) return filePath;
    if (path.dirname(currentDirPath) === currentDirPath) return undefined;
  }
}

// Keyed by WB_ENV so a development server and an e2e run of the same repository, which deliberately
// listen on different ports, publish different files instead of overwriting each other.
function buildLocalServerUrlFilePath(dirPath: string, wbEnv: string | undefined): string | undefined {
  if (!wbEnv || !LOCAL_SERVER_WB_ENVS.has(wbEnv)) return undefined;
  return path.join(dirPath, WB_DIRECTORY_NAME, `server-${wbEnv}.url`);
}
