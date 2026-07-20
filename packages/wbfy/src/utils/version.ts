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
  if (!gitRootDirPath || path.relative(gitRootDirPath, dirPath) !== wbfyDirPathInRepo) return undefined;
  const commitHash = runGit(['rev-parse', '--short', 'HEAD'], dirPath);
  if (!commitHash) return undefined;
  // The commit alone would misidentify a build made from an edited checkout, so uncommitted changes
  // are reported too — but only under packages/, which holds wbfy and the workspace dependencies it
  // is built from. A repository-wide check would also see the files wbfy GENERATES when it targets
  // its own repository (e.g. the README this label goes into), making a second run relabel the
  // badge `-dirty-local` purely because the first run wrote it.
  const isDirty = !!runGit(['status', '--porcelain', '--', path.dirname(wbfyDirPathInRepo)], gitRootDirPath);
  return isDirty ? `${commitHash}-dirty-local` : `${commitHash}-local`;
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
