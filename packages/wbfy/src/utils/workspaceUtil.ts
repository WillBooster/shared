import path from 'node:path';

import fg from 'fast-glob';
import type { PackageJson } from 'type-fest';

import type { PackageConfig } from '../packageConfig.js';

/** The subset of PackageConfig that workspace discovery needs, so it can run before configs exist. */
export type WorkspaceRootLike = Pick<PackageConfig, 'dirPath' | 'doesContainSubPackageJsons' | 'packageJson'>;

/**
 * Every declared workspace directory (absolute, deduplicated) of the monorepo root, covering
 * non-packages/* layouts such as apps/*. Uncached because index.ts calls it before wbfy mutates
 * the root package.json (getWorkspacePackageDirs caches the post-mutation state).
 */
export function getWorkspaceSubDirPaths(rootLike: WorkspaceRootLike): string[] {
  return [
    ...new Set(
      getWorkspacePackageJsonPaths(rootLike).map((packageJsonPath) =>
        path.resolve(rootLike.dirPath, path.posix.dirname(packageJsonPath))
      )
    ),
  ].toSorted();
}

/**
 * Every workspace package.json path (relative to the monorepo root), including manifests without
 * a `name` field — wbfy names those later, so dependency scans must not skip them.
 */
export function getWorkspacePackageJsonPaths(rootConfig: WorkspaceRootLike): string[] {
  // Expand all patterns in one glob call so Bun-supported negative patterns (e.g.
  // `!packages/excluded`) actually exclude their matches. Do not apply globIgnore here: workspace
  // membership is defined solely by the declared patterns, and source-scanning ignores such as
  // `build` or `dist` would hide legitimately named workspace directories.
  const packageJsonGlobs = getSanitizedWorkspacePatterns(rootConfig).map((workspacePattern) =>
    workspacePattern.startsWith('!')
      ? `!${path.posix.join(workspacePattern.slice(1), 'package.json')}`
      : path.posix.join(workspacePattern, 'package.json')
  );
  // followSymbolicLinks: false — a workspace symlink pointing outside the repository must not be
  // treated as a workspace directory (removeNodeModules would delete through it).
  return fg.globSync(packageJsonGlobs, {
    cwd: rootConfig.dirPath,
    followSymbolicLinks: false,
    ignore: ['**/node_modules/**'],
  });
}

/**
 * Sorted non-negative workspace directory patterns (posix, relative to the monorepo root), for
 * generators that need pattern-shaped globs covering every workspace layout — e.g. the root
 * tsconfig's `apps/*` include entries — instead of concrete directories, which would churn
 * generated files whenever a workspace package is added or removed.
 */
export function getWorkspaceDirPatterns(rootLike: WorkspaceRootLike): string[] {
  return getSanitizedWorkspacePatterns(rootLike)
    .filter((workspacePattern) => !workspacePattern.startsWith('!'))
    .toSorted();
}

/**
 * Declared workspace patterns (negative ones included) that stay inside the repository: absolute
 * or `..`-traversing patterns would make consumers such as removeNodeModules operate on another
 * repository's files.
 */
function getSanitizedWorkspacePatterns(rootLike: WorkspaceRootLike): string[] {
  // applyPackageJsonConventions forces `packages/*` into every monorepo's workspaces, but it may
  // not have written the root package.json yet, so mirror that normalization here.
  const workspacePatterns = [
    ...new Set([
      ...getDeclaredWorkspacePatterns(rootLike.packageJson?.workspaces),
      ...(rootLike.doesContainSubPackageJsons ? ['packages/*'] : []),
    ]),
  ];
  return workspacePatterns.filter((workspacePattern) => {
    const patternBody = workspacePattern.startsWith('!') ? workspacePattern.slice(1) : workspacePattern;
    return !path.posix.isAbsolute(patternBody) && !patternBody.split('/').includes('..');
  });
}

/** Workspace patterns from either the array form or Yarn v1's `{ packages: […] }` object form. */
export function getDeclaredWorkspacePatterns(workspaces: PackageJson['workspaces']): string[] {
  if (Array.isArray(workspaces)) return workspaces;
  return Array.isArray(workspaces?.packages) ? workspaces.packages : [];
}
