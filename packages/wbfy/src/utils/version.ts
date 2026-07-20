import child_process from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The version wbfy's own package.json carries in the repository. `@semantic-release/npm` rewrites
 * it in the published tarball only (it is never committed back), so a wbfy run started from a git
 * checkout reports this placeholder instead of a real version.
 */
const unreleasedVersionPrefix = '0.0.0-';

export function getWbfyVersion(): string {
  return readWbfyPackageJson().version;
}

/** wbfy's location inside its own repository, relative to the repository root. */
const wbfyDirPathInRepo = path.join('packages', 'wbfy');

/**
 * Identifies the wbfy build that produced the generated files: the released version, or
 * `<short commit hash>[-dirty]-local` when wbfy runs from its own git checkout. Undefined when
 * neither is available (e.g. an unreleased build extracted from a source archive).
 */
export function getWbfyVersionLabel(): string | undefined {
  const { version, dirPath } = readWbfyPackageJson();
  if (!version.startsWith(unreleasedVersionPrefix)) return version;

  // git resolves the NEAREST enclosing repository, which for an unreleased build placed under a
  // target repository (node_modules, or a vendored/extracted source tree) is that repository — its
  // commit says nothing about the wbfy build that ran. Only wbfy's own location inside its own
  // repository identifies a genuine checkout, so anything else falls back to the version-less label.
  const gitRootDirPath = runGit(['rev-parse', '--show-toplevel'], dirPath);
  if (
    !gitRootDirPath ||
    path.relative(gitRootDirPath, dirPath) !== wbfyDirPathInRepo ||
    !isWbfyRepository(gitRootDirPath)
  ) {
    return undefined;
  }
  const commitHash = runGit(['rev-parse', '--short=8', 'HEAD'], dirPath);
  if (!commitHash) return undefined;
  // The commit alone would misidentify a build made from an edited checkout, so uncommitted changes
  // are reported too — but only under packages/*/src, the source wbfy and its workspace dependencies
  // are built from. Everything wbfy GENERATES when it targets its own repository lives outside that
  // (the root README this label goes into, and each package's .gitignore, package.json, tsconfig,
  // …), so a first run cannot make the next one relabel the badge `-dirty-local` by itself.
  const isDirty = getGitDirtyState(gitRootDirPath);
  if (isDirty === undefined) return undefined;
  return isDirty ? `${commitHash}-dirty-local` : `${commitHash}-local`;
}

function isWbfyRepository(gitRootDirPath: string): boolean {
  // Every remote counts, not just `origin`: a fork checkout carries the canonical repository as
  // `upstream`, and it is still a genuine wbfy checkout whose commit identifies the build.
  const remoteUrls = runGit(['remote', '-v'], gitRootDirPath);
  return !!remoteUrls
    ?.split('\n')
    .some((line) => /github\.com[:/]WillBooster\/shared(?:\.git)?$/iu.test(line.split(/[ \t]+/u)[1] ?? ''));
}

function getGitDirtyState(gitRootDirPath: string): boolean | undefined {
  const proc = child_process.spawnSync(
    'git',
    ['status', '--porcelain', '--untracked-files=all', '--', `:(glob)${path.dirname(wbfyDirPathInRepo)}/*/src/**`],
    { cwd: gitRootDirPath, encoding: 'utf8', stdio: 'pipe' }
  );
  return proc.status === 0 ? !!proc.stdout.trim() : undefined;
}

function runGit(args: string[], cwd: string): string | undefined {
  const proc = child_process.spawnSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' });
  return proc.status === 0 ? proc.stdout.trim() || undefined : undefined;
}

function readWbfyPackageJson(): { version: string; dirPath: string } {
  // fileURLToPath, not URL.pathname: the latter keeps percent-encoding, so an installation path
  // containing e.g. a space would resolve to a nonexistent directory and the search would walk up
  // to an unrelated package.
  let dirPath = path.dirname(fileURLToPath(import.meta.url));
  while (!fs.existsSync(path.join(dirPath, 'package.json'))) {
    const parentDirPath = path.dirname(dirPath);
    // path.dirname('/') === '/', so the search must stop explicitly at the filesystem root.
    if (parentDirPath === dirPath) throw new Error("wbfy's own package.json is missing.");
    dirPath = parentDirPath;
  }
  const packageJson = JSON.parse(fs.readFileSync(path.join(dirPath, 'package.json'), 'utf8')) as { version: string };
  return { version: packageJson.version, dirPath };
}
