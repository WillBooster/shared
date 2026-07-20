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

/**
 * Identifies the wbfy build that produced the generated files: the released version, or
 * `<short commit hash>-local` when wbfy runs from its own git checkout. Undefined when neither is
 * available (e.g. an unreleased build extracted from a source archive).
 */
export function getWbfyVersionLabel(): string | undefined {
  const { version, dirPath } = readWbfyPackageJson();
  if (!version.startsWith(unreleasedVersionPrefix)) return version;

  // An unreleased build installed under a TARGET repository (e.g. a packed tarball in its
  // node_modules) would make git resolve that repository's HEAD, stamping an unrelated commit as
  // the applied wbfy build. Such an installation always sits below a node_modules directory of the
  // discovered repository, so that path segment distinguishes it from a genuine wbfy checkout.
  const gitRootDirPath = runGit(['rev-parse', '--show-toplevel'], dirPath);
  if (!gitRootDirPath || path.relative(gitRootDirPath, dirPath).split(path.sep).includes('node_modules')) {
    return undefined;
  }
  const commitHash = runGit(['rev-parse', '--short', 'HEAD'], dirPath);
  return commitHash ? `${commitHash}-local` : undefined;
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
