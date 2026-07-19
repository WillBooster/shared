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

export interface WorkspaceDirPatterns {
  /** Directory subtrees matched by negative workspace patterns, for tsconfig `exclude` entries. */
  excludes: string[];
  /** Positive directory patterns (or concrete directories for Bun-only glob syntax). */
  includes: string[];
}

/**
 * Sorted workspace directory patterns (posix, relative to the monorepo root) for generators that
 * need pattern-shaped globs covering every workspace layout — e.g. the root tsconfig's `apps/*`
 * include entries — instead of concrete directories, which would churn generated files whenever a
 * workspace package is added or removed. Every returned pattern is valid tsconfig glob syntax.
 * A pattern can match a sibling directory without a package.json (not a workspace to Bun); that
 * is deliberate, mirroring the long-standing `packages/*` entries' behavior in favor of stable
 * generated output. Known limitation (#1004): a negation whose directory is an ANCESTOR of
 * another workspace (e.g. `["apps/**", "!apps"]`) excludes the whole subtree here, although Bun
 * excludes only the package at that directory; such nested workspace layouts do not occur in
 * WillBooster repositories.
 */
export function getWorkspaceDirPatterns(rootLike: WorkspaceRootLike): WorkspaceDirPatterns {
  // Unlike discovery, generated output must not contain a never-matching `packages/*` fallback:
  // an apps/*-only monorepo would get dead globs committed into its root tsconfig. Mirror
  // applyPackageJsonConventions, which forces `packages/*` only when a manifest actually matches.
  const hasPackagesLayout =
    rootLike.doesContainSubPackageJsons &&
    fg.globSync('packages/*/package.json', {
      cwd: rootLike.dirPath,
      followSymbolicLinks: false,
      ignore: ['**/node_modules/**'],
    }).length > 0;
  const excludes = new Set<string>();
  const includes = new Set<string>();
  for (const workspacePattern of getSanitizedWorkspacePatterns({
    ...rootLike,
    doesContainSubPackageJsons: hasPackagesLayout,
  })) {
    const isNegative = workspacePattern.startsWith('!');
    // Normalization collapses `//` and strips trailing slashes so template-literal consumers
    // (e.g. `${pattern}/src/**/*`) never emit doubled separators for patterns like `apps/*/`.
    const patternBody = path.posix
      .normalize(isNegative ? workspacePattern.slice(1) : workspacePattern)
      .replace(/\/+$/u, '');
    for (const dirPattern of toTsconfigCompatibleDirPatterns(patternBody, rootLike.dirPath)) {
      (isNegative ? excludes : includes).add(dirPattern);
    }
  }
  return { excludes: [...excludes].toSorted(), includes: [...includes].toSorted() };
}

/**
 * tsconfig include/exclude support only the `*`, `?`, and `**` wildcards, while Bun workspaces
 * accept full glob syntax (brace expansion, character classes, …), so expand Bun-only patterns to
 * the concrete directories they match to keep the generated globs valid for TypeScript.
 */
function toTsconfigCompatibleDirPatterns(patternBody: string, rootDirPath: string): string[] {
  if (!/[()[\]{}]/u.test(patternBody)) return [patternBody];
  return fg.globSync(patternBody, {
    cwd: rootDirPath,
    followSymbolicLinks: false,
    ignore: ['**/node_modules/**'],
    onlyDirectories: true,
  });
}

/**
 * Declared workspace patterns (negative ones included) that stay inside the repository: absolute
 * or `..`-traversing patterns would make consumers such as removeNodeModules operate on another
 * repository's files.
 */
function getSanitizedWorkspacePatterns(rootLike: WorkspaceRootLike): string[] {
  // applyPackageJsonConventions forces `packages/*` into a monorepo's workspaces when a
  // packages/*/package.json actually matches, but it may not have written the root package.json
  // yet, so mirror that normalization here. Discovery callers pass the fallback unconditionally
  // for monorepos — a never-matching pattern contributes no paths there — while pattern-shaped
  // callers (getWorkspaceDirPatterns) gate it on an actual match.
  // Bun ignores empty patterns (`""` and a lone `"!"`), so they must not count as declarations —
  // a lone `"!"` would otherwise trigger the negative-only implicit baseline below, and `""`
  // would make the repository root itself a discovered workspace.
  const declaredPatterns = getDeclaredWorkspacePatterns(rootLike.packageJson?.workspaces).filter((workspacePattern) => {
    const patternBody = workspacePattern.startsWith('!') ? workspacePattern.slice(1) : workspacePattern;
    return patternBody !== '' && patternBody !== '.';
  });
  // Bun applies an implicit `*/*` baseline when the declaration contains only negative patterns
  // (verified with Bun 1.3.14: `workspaces: ["!excluded/*"]` makes every other two-level
  // package.json a workspace, while depth-1 and depth-3 manifests stay out).
  const hasOnlyNegativePatterns =
    declaredPatterns.length > 0 && declaredPatterns.every((workspacePattern) => workspacePattern.startsWith('!'));
  const workspacePatterns = [
    ...new Set([
      ...(hasOnlyNegativePatterns ? ['*/*'] : []),
      ...declaredPatterns,
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
