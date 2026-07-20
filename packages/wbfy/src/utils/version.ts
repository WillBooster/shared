import child_process from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

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

  const proc = child_process.spawnSync('git', ['rev-parse', '--short', 'HEAD'], {
    cwd: dirPath,
    encoding: 'utf8',
    stdio: 'pipe',
  });
  const commitHash = proc.status === 0 ? proc.stdout.trim() : '';
  return commitHash ? `${commitHash}-local` : undefined;
}

function readWbfyPackageJson(): { version: string; dirPath: string } {
  let dirPath = path.dirname(new URL(import.meta.url).pathname);
  while (!fs.existsSync(path.join(dirPath, 'package.json'))) {
    dirPath = path.dirname(dirPath);
  }
  const packageJson = JSON.parse(fs.readFileSync(path.join(dirPath, 'package.json'), 'utf8')) as { version: string };
  return { version: packageJson.version, dirPath };
}
