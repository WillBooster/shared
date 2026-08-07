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
  // Neither the installed package.json nor the git state of wbfy's own checkout can change
  // mid-run, and computing the label spawns several git subprocesses, so it is computed once.
  if (!hasComputedVersionLabel) {
    cachedVersionLabel = computeWbfyVersionLabel();
    hasComputedVersionLabel = true;
  }
  return cachedVersionLabel;
}

let hasComputedVersionLabel = false;
let cachedVersionLabel: string | undefined;

function computeWbfyVersionLabel(): string | undefined {
  const { name, version, dirPath } = readWbfyPackageJson();
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
  // are reported too — but only under packages/*/src and packages/*/bin, the source and entry-point
  // wrapper wbfy and its workspace dependencies actually run from. Everything wbfy GENERATES when it
  // targets its own repository lives outside those (the root README this label goes into, and each
  // package's .gitignore, package.json, tsconfig, …), so a first run cannot make the next one
  // relabel the badge `-dirty-local` by itself.
  // Manifests stay out on purpose, even though an edited `exports` map can redirect which code
  // loads: wbfy GENERATES package.json, so including it would make every run report itself dirty.
  // The label is best-effort build provenance, not a reproducible-build attestation.
  const isDirty = getGitDirtyState(gitRootDirPath);
  if (isDirty === undefined) return undefined;
  if (isDirty) return `${commitHash}-dirty-local`;
  // An unmodified checkout sitting on a release tag runs exactly the code that was published under
  // that version, so it is labeled with the version instead of the commit that only wbfy developers
  // could resolve back to one.
  return findReleasedVersionAtHead(name, dirPath) ?? `${commitHash}-local`;
}

/** `@semantic-release/npm` tags each release `<package name>@<version>`. */
function findReleasedVersionAtHead(packageName: string, cwd: string): string | undefined {
  const tagPrefix = `${packageName}@`;
  // A commit carries at most one release tag per package, so the first match is the only match.
  return runGit(['tag', '--points-at', 'HEAD'], cwd)
    ?.split('\n')
    .find((tag) => tag.startsWith(tagPrefix))
    ?.slice(tagPrefix.length);
}

function isWbfyRepository(gitRootDirPath: string): boolean {
  // Every remote counts, not just `origin`: a fork checkout carries the canonical repository as
  // `upstream`, and it is still a genuine wbfy checkout whose commit identifies the build.
  const remoteUrls = runGit(['remote', '-v'], gitRootDirPath);
  return !!remoteUrls?.split('\n').some((line) => isCanonicalRemoteUrl(line.split(/[ \t]+/u)[1] ?? ''));
}

const canonicalRepositoryPath = /^\/?WillBooster\/shared(?:\.git)?$/iu;

/**
 * Whether the remote URL points at wbfy's own repository. The host is compared after PARSING rather
 * than matched inside the string: any pattern loose enough to accept every URL form git supports
 * also accepted a lookalike that merely contains the host, such as
 * `https://evil.example//github.com/WillBooster/shared.git`, letting an unrelated checkout claim to
 * be a genuine wbfy build.
 */
function isCanonicalRemoteUrl(url: string): boolean {
  // scp-style (`git@github.com:WillBooster/shared.git`) is not a URL, so it is matched separately.
  // The lookahead keeps a scheme's `://` from being read as the `host:path` separator.
  const scpMatch = /^(?:[^@/]+@)?([^/:]+):(?!\/)(.*)$/u.exec(url);
  if (scpMatch) {
    return scpMatch[1]!.toLowerCase() === 'github.com' && canonicalRepositoryPath.test(scpMatch[2]!);
  }
  try {
    const { hostname, pathname } = new URL(url);
    return hostname.toLowerCase() === 'github.com' && canonicalRepositoryPath.test(pathname);
  } catch {
    return false;
  }
}

function getGitDirtyState(gitRootDirPath: string): boolean | undefined {
  const proc = child_process.spawnSync(
    'git',
    [
      'status',
      '--porcelain',
      '--untracked-files=all',
      '--',
      `:(glob)${path.dirname(wbfyDirPathInRepo)}/*/src/**`,
      `:(glob)${path.dirname(wbfyDirPathInRepo)}/*/bin/**`,
      // configs/ holds the release-age policy wbfy writes into every generated repository.
      `:(glob)${path.dirname(wbfyDirPathInRepo)}/*/configs/**`,
    ],
    { cwd: gitRootDirPath, encoding: 'utf8', stdio: 'pipe' }
  );
  return proc.status === 0 ? !!proc.stdout.trim() : undefined;
}

function runGit(args: string[], cwd: string): string | undefined {
  const proc = child_process.spawnSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' });
  return proc.status === 0 ? proc.stdout.trim() || undefined : undefined;
}

let cachedWbfyPackageJson: { name: string; version: string; dirPath: string } | undefined;

/** Returns wbfy's own package directory, which also holds its configs (e.g. releaseAgeGate.json). */
export function getWbfyDirPath(): string {
  return readWbfyPackageJson().dirPath;
}

function readWbfyPackageJson(): { name: string; version: string; dirPath: string } {
  if (cachedWbfyPackageJson) return cachedWbfyPackageJson;
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
  const packageJson = JSON.parse(fs.readFileSync(path.join(dirPath, 'package.json'), 'utf8')) as {
    name: string;
    version: string;
  };
  cachedWbfyPackageJson = { name: packageJson.name, version: packageJson.version, dirPath };
  return cachedWbfyPackageJson;
}
