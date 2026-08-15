import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

import type { Project } from '../project.js';

// Only local environments serve a URL that cannot be known ahead of time; staging and production
// always carry a fixed, deployed URL that a local file must never shadow.
const LOCAL_SERVER_WB_ENVS = new Set(['development', 'test']);
const WB_DIRECTORY_NAME = '.wb';
const URL_FILE_EXTENSION = '.url';
const PID_FILE_EXTENSION = '.pid';
const SCHEME_DEFAULT_PORTS = new Map([
  ['http:', 80],
  ['https:', 443],
]);
const SERVING_PROBE_TIMEOUT_MS = 1000;

/**
 * Publishes the URL of the server `wb start` / `wb test` is about to serve into
 * `<repository root>/.wb/server-<WB_ENV>-<package>.url`, and removes it when this process exits.
 *
 * Commands that merely CONSUME the app (e.g. `wb run scripts/importProblems.ts`) cannot compute an
 * auto-selected port: the selection returns a FREE port, i.e. never the one a running server
 * occupies. Without this file, a repository whose scripts must name the local server would have to
 * pin PORT for that reason alone. The file holds the bare URL so any language can read it, and a
 * `.pid` sibling records the publisher so a crashed one cannot be mistaken for a live server by an
 * unrelated process that later takes the same port.
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
  fs.writeFileSync(toPidFilePath(filePath), `${process.pid}\n`);
  // Only the synchronous 'exit' event is hooked: a signal listener would suppress Node's default
  // termination. Signals wb handles itself still reach it (src/index.ts exits explicitly), and a
  // publication surviving SIGKILL misleads nobody because a reader ignores a dead publisher.
  process.on('exit', () => {
    try {
      // A later server of the same package republishes this path with its own free port, so
      // removing it blindly would strand a server that is still serving.
      if (fs.readFileSync(filePath, 'utf8') !== content) return;
      // The pid goes first: a reader that catches the intermediate state must conclude "gone",
      // never "published by a live process".
      fs.rmSync(toPidFilePath(filePath), { force: true });
      fs.rmSync(filePath, { force: true });
    } catch {
      // An already removed file (e.g. another process wiping .wb) must not break the exit.
    }
  });
}

/**
 * Reads the URL of a local server that is serving right now, or undefined when none is.
 *
 * `preferredProjectName` names the caller's own package, which wins whenever it is serving. A
 * repository root — where a consuming script cannot belong to any single app — falls back to the
 * one app that is serving; anywhere else no fallback applies, because handing a package's script
 * a sibling app's URL is worse than handing it nothing.
 */
export async function readLocalServerUrl(
  cwd: string,
  wbEnv: string | undefined,
  preferredProjectName?: string
): Promise<string | undefined> {
  const wbDirPath = findRepositoryWbDirectoryPath(cwd);
  if (!wbDirPath || !wbEnv || !LOCAL_SERVER_WB_ENVS.has(wbEnv)) return undefined;

  const rootDirPath = path.dirname(wbDirPath);
  const preferredFilePath = preferredProjectName
    ? buildLocalServerUrlFilePath(rootDirPath, wbEnv, preferredProjectName)
    : undefined;
  if (preferredFilePath) {
    const preferredUrl = await readServingUrl(preferredFilePath);
    if (preferredUrl) return preferredUrl;
  }
  if (path.resolve(cwd) !== rootDirPath) return undefined;

  // Liveness decides which publications count: a crashed server's file lingers until something
  // republishes it, and letting it vote would make one stale file hide the app that IS serving.
  const candidateUrls = await Promise.all(
    listLocalServerUrlFilePaths(wbDirPath, wbEnv).map((filePath) => readServingUrl(filePath))
  );
  const servingUrls = candidateUrls.filter((url) => url !== undefined);
  // Several apps of one monorepo cannot be told apart without a name, and guessing would point the
  // script at the wrong app.
  return servingUrls.length === 1 ? servingUrls[0] : undefined;
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

/** The published URL when its publisher is alive and its origin answers, else undefined. */
async function readServingUrl(filePath: string): Promise<string | undefined> {
  let baseUrl: string;
  let url: URL;
  try {
    if (!isPublisherAlive(Number(fs.readFileSync(toPidFilePath(filePath), 'utf8')))) return undefined;
    baseUrl = fs.readFileSync(filePath, 'utf8').trim();
    url = new URL(baseUrl);
  } catch {
    return undefined;
  }
  // `URL#port` is empty for a scheme's default port, so `http://localhost:80` must not read as
  // portless — the probe below needs the port the server actually listens on.
  const port = url.port ? Number(url.port) : SCHEME_DEFAULT_PORTS.get(url.protocol);
  if (!port) return undefined;
  return (await isServing(url.hostname, port)) ? baseUrl : undefined;
}

/**
 * Connects rather than binds. `isPortAvailable` would hold the port for an event-loop turn, and
 * the URL is published BEFORE the server binds it (see ensurePort), so a bind probe could take the
 * port from the very server it is asking about and kill it with EADDRINUSE. Connecting to the
 * published origin also answers the question the consumer actually has: can this URL be reached?
 */
function isServing(hostname: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: hostname, port });
    const finish = (serving: boolean): void => {
      socket.destroy();
      resolve(serving);
    };
    socket.setTimeout(SERVING_PROBE_TIMEOUT_MS);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

/** Signal 0 tests for existence; EPERM means the process exists under another user. */
function isPublisherAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function listLocalServerUrlFilePaths(wbDirPath: string, wbEnv: string): string[] {
  let fileNames: string[];
  try {
    fileNames = fs.readdirSync(wbDirPath);
  } catch {
    return [];
  }
  const prefix = `server-${wbEnv}-`;
  return fileNames
    .filter((fileName) => fileName.startsWith(prefix) && fileName.endsWith(URL_FILE_EXTENSION))
    .map((fileName) => path.join(wbDirPath, fileName));
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
  // Percent-encoding is injective and leaves every npm-legal name a single filename-safe segment,
  // unlike replacing unsafe characters, which maps `@foo/bar-baz` and `@foo-bar/baz` alike.
  return path.join(
    rootDirPath,
    WB_DIRECTORY_NAME,
    `server-${wbEnv}-${encodeURIComponent(projectName)}${URL_FILE_EXTENSION}`
  );
}

function toPidFilePath(filePath: string): string {
  return `${filePath.slice(0, -URL_FILE_EXTENSION.length)}${PID_FILE_EXTENSION}`;
}
