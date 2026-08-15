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
const UNNAMED_PACKAGE_NAME = 'unknown';
const SCHEME_DEFAULT_PORTS = new Map([
  ['http:', 80],
  ['https:', 443],
]);
const SERVING_PROBE_TIMEOUT_MS = 1000;

/**
 * Publishes the URL of the server `wb start` / `wb test` is about to serve into
 * `<repository root>/.wb/server-<WB_ENV>-<package>.url`.
 *
 * A publication is never deleted, only overwritten by the next server of the same package: a
 * reader accepts one only while its publisher is alive and its origin answers, so an outdated file
 * is already inert. Deleting on exit would buy nothing but tidiness and cannot be made correct —
 * checking ownership and unlinking are separate syscalls, so an exiting server can always be
 * preempted between them and remove the replacement that a pinned-port restart just published.
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
  // The Git repository, not Project#rootDirPath, whose depth-2 heuristic would disagree with the
  // reader for a workspace nested at another depth (e.g. `apps/group/*`) and silently no-op.
  const rootDirPath = findRepositoryRootDirPath(project.dirPath) ?? project.rootDirPath;
  const filePath = buildLocalServerUrlFilePath(rootDirPath, project.env.WB_ENV, project.name);
  if (!filePath) return;

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  // The pid goes first: a reader that catches the intermediate state must find the OLD url with a
  // new pid — a combination its liveness probe rejects — never a new url attributed to a publisher
  // that has already gone.
  fs.writeFileSync(toPidFilePath(filePath), `${process.pid}\n`);
  fs.writeFileSync(filePath, `${baseUrl}\n`);
}

/**
 * Reads the URL of a local server that is serving right now, or undefined when none is.
 *
 * The caller's own package wins whenever it is serving. A caller that belongs to no app — the
 * repository root package, or a directory with no package.json above it — falls back to the one
 * app that is serving; a caller inside another package gets nothing instead, because handing a
 * package's script a sibling app's URL is worse than handing it nothing.
 */
export async function readLocalServerUrl(cwd: string, wbEnv: string | undefined): Promise<string | undefined> {
  const rootDirPath = findRepositoryRootDirPath(cwd);
  if (!rootDirPath || !wbEnv || !LOCAL_SERVER_WB_ENVS.has(wbEnv)) return undefined;

  const owner = findOwningPackage(cwd, rootDirPath);
  const ownerFilePath = owner.name && buildLocalServerUrlFilePath(rootDirPath, wbEnv, owner.name);
  if (ownerFilePath) {
    const ownerUrl = await readServingUrl(ownerFilePath);
    if (ownerUrl) return ownerUrl;
  }
  if (!owner.belongsToNoApp) return undefined;

  // Liveness decides which publications count: a crashed server's file lingers until something
  // republishes it, and letting it vote would make one stale file hide the app that IS serving.
  const wbDirPath = path.join(rootDirPath, WB_DIRECTORY_NAME);
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
export async function applyLocalServerUrl(cwd: string, env: NodeJS.ProcessEnv): Promise<void> {
  if (env.NEXT_PUBLIC_BASE_URL !== undefined) return;

  const baseUrl = await readLocalServerUrl(cwd, env.WB_ENV);
  if (baseUrl) env.NEXT_PUBLIC_BASE_URL = baseUrl;
}

/**
 * The package a working directory belongs to. Resolved by walking up rather than by inspecting the
 * directory itself: `wb run` accepts a manifest-less directory (e.g. `packages/app/scripts`), whose
 * script belongs to the app above it, while a directory under the repository root with no package
 * above it belongs to no app at all.
 */
function findOwningPackage(cwd: string, rootDirPath: string): { name?: string; belongsToNoApp: boolean } {
  for (let currentDirPath = path.resolve(cwd); ; currentDirPath = path.dirname(currentDirPath)) {
    const packageJsonPath = path.join(currentDirPath, 'package.json');
    if (fs.existsSync(packageJsonPath)) {
      let name = UNNAMED_PACKAGE_NAME;
      try {
        name = (JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as { name?: string }).name || name;
      } catch {
        // A malformed manifest is not this feature's problem; the unnamed fallback matches Project#name.
      }
      return { name, belongsToNoApp: currentDirPath === rootDirPath };
    }
    if (currentDirPath === rootDirPath || path.dirname(currentDirPath) === currentDirPath) {
      return { belongsToNoApp: true };
    }
  }
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
  // `URL#hostname` keeps the brackets of an IPv6 literal, which net.connect would resolve as a
  // hostname and fail with ENOTFOUND.
  const hostname = url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname;
  return (await isServing(hostname, port)) ? baseUrl : undefined;
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
 * The repository is both the publication site and the search boundary, so the writer and the
 * reader cannot disagree; walking further would let a stray `.wb` in a parent workspace or the
 * home directory answer for a project that published nothing.
 */
function findRepositoryRootDirPath(dirPath: string): string | undefined {
  for (let currentDirPath = path.resolve(dirPath); ; currentDirPath = path.dirname(currentDirPath)) {
    // A worktree's `.git` is a file rather than a directory, which existsSync covers alike.
    if (fs.existsSync(path.join(currentDirPath, '.git'))) return currentDirPath;
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
