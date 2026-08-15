import fs from 'node:fs';
import path from 'node:path';

import type { Project } from '../project.js';

import { isPortAvailable } from './port.js';

// Only local environments serve a URL that cannot be known ahead of time; staging and production
// always carry a fixed, deployed URL that a local file must never shadow.
const LOCAL_SERVER_WB_ENVS = new Set(['development', 'test']);
const WB_DIRECTORY_NAME = '.wb';
const SCHEME_DEFAULT_PORTS = new Map([
  ['http:', 80],
  ['https:', 443],
]);

/**
 * Publishes the URL of the server `wb start` / `wb test` is about to serve into
 * `<repository root>/.wb/server-<WB_ENV>-<package>.url`, and removes it when this process exits.
 *
 * Commands that merely CONSUME the app (e.g. `wb run scripts/importProblems.ts`) cannot compute an
 * auto-selected port: the selection returns a FREE port, i.e. never the one a running server
 * occupies. Without this file, a repository whose scripts must name the local server would have to
 * pin PORT for that reason alone. The file holds the bare URL so any language can read it.
 *
 * It lives at the REPOSITORY root, not the package directory, because `wb start` serves each
 * descendant project (see start.ts) while a consuming script commonly runs at the root: a reader
 * searching upward from its own directory would never see a descendant's file. The package name
 * keeps concurrent app servers of one monorepo apart.
 */
export function publishLocalServerUrl(project: Project, baseUrl: string): void {
  const filePath = buildLocalServerUrlFilePath(project.rootDirPath, project.env.WB_ENV, project.name);
  if (!filePath) return;

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const content = `${baseUrl}\n`;
  fs.writeFileSync(filePath, content);
  // Only the synchronous 'exit' event is hooked: a signal listener would suppress Node's default
  // termination, and a file surviving a crash misleads nobody because readLocalServerUrl ignores
  // one whose port serves nothing.
  process.on('exit', () => {
    try {
      // A later server of the same package republishes this path with its own free port, so
      // removing it blindly would strand a server that is still serving.
      if (fs.readFileSync(filePath, 'utf8') === content) fs.rmSync(filePath, { force: true });
    } catch {
      // An already removed file (e.g. another process wiping .wb) must not break the exit.
    }
  });
}

/**
 * Reads the URL published by a local server that is still serving, or undefined when none is.
 * `preferredProjectName` selects among the app servers of a monorepo; without a match, an
 * unambiguous single publication answers, because a consuming script at the repository root
 * usually means the one app the repository serves.
 */
export async function readLocalServerUrl(
  cwd: string,
  wbEnv: string | undefined,
  preferredProjectName?: string
): Promise<string | undefined> {
  const filePath = selectLocalServerUrlFilePath(cwd, wbEnv, preferredProjectName);
  if (!filePath) return undefined;

  let baseUrl: string;
  let port: number | undefined;
  try {
    baseUrl = fs.readFileSync(filePath, 'utf8').trim();
    const url = new URL(baseUrl);
    // `URL#port` is empty for a scheme's default port, so `http://localhost:80` must not read as
    // portless — the probe below needs the port the server actually listens on.
    port = url.port ? Number(url.port) : SCHEME_DEFAULT_PORTS.get(url.protocol);
  } catch {
    return undefined;
  }
  // The URL is published while the start command is still being BUILT, so an unbound port means
  // "not serving yet" just as often as "the server crashed". Either way there is nothing to
  // consume — and deleting the file here would strand the server that is about to bind it, since
  // each server publishes only once.
  if (!port || (await isPortAvailable(port))) return undefined;
  return baseUrl;
}

/**
 * Lets a consuming command reach the running local server without a pinned PORT. A configured
 * value always wins, including a deliberately empty one: the file answers only what nothing else
 * could have.
 */
export async function applyLocalServerUrl(
  cwd: string,
  env: NodeJS.ProcessEnv,
  preferredProjectName?: string
): Promise<void> {
  if (env.NEXT_PUBLIC_BASE_URL !== undefined) return;

  const baseUrl = await readLocalServerUrl(cwd, env.WB_ENV, preferredProjectName);
  if (baseUrl) env.NEXT_PUBLIC_BASE_URL = baseUrl;
}

function selectLocalServerUrlFilePath(
  cwd: string,
  wbEnv: string | undefined,
  preferredProjectName: string | undefined
): string | undefined {
  const wbDirPath = findRepositoryWbDirectoryPath(cwd);
  if (!wbDirPath || !wbEnv || !LOCAL_SERVER_WB_ENVS.has(wbEnv)) return undefined;

  const preferredFilePath =
    preferredProjectName && buildLocalServerUrlFilePath(path.dirname(wbDirPath), wbEnv, preferredProjectName);
  if (preferredFilePath && fs.existsSync(preferredFilePath)) return preferredFilePath;

  let fileNames: string[];
  try {
    fileNames = fs.readdirSync(wbDirPath);
  } catch {
    return undefined;
  }
  const prefix = `server-${wbEnv}-`;
  const candidates = fileNames.filter((fileName) => fileName.startsWith(prefix) && fileName.endsWith('.url'));
  // Several app servers of one monorepo cannot be told apart without a name, and guessing would
  // point the script at the wrong app.
  return candidates.length === 1 ? path.join(wbDirPath, candidates[0] as string) : undefined;
}

/**
 * The repository is the search boundary: walking to the filesystem root would let a stray `.wb` in
 * a parent workspace or the home directory answer for a project that published nothing.
 */
function findRepositoryWbDirectoryPath(cwd: string): string | undefined {
  for (let currentDirPath = path.resolve(cwd); ; currentDirPath = path.dirname(currentDirPath)) {
    // A worktree's `.git` is a file rather than a directory, which existsSync covers alike.
    if (fs.existsSync(path.join(currentDirPath, '.git'))) return path.join(currentDirPath, WB_DIRECTORY_NAME);
    if (path.dirname(currentDirPath) === currentDirPath) return undefined;
  }
}

// Keyed by WB_ENV so a development server and an e2e run of the same repository, which deliberately
// listen on different ports, publish different files instead of overwriting each other.
function buildLocalServerUrlFilePath(
  rootDirPath: string,
  wbEnv: string | undefined,
  projectName: string
): string | undefined {
  if (!wbEnv || !LOCAL_SERVER_WB_ENVS.has(wbEnv)) return undefined;
  return path.join(rootDirPath, WB_DIRECTORY_NAME, `server-${wbEnv}-${toFileNameSegment(projectName)}.url`);
}

function toFileNameSegment(projectName: string): string {
  return projectName.replaceAll(/[^\w.-]/g, '-');
}
