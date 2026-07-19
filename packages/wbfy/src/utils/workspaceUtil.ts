import fs from 'node:fs';
import path from 'node:path';

import {
  getMeaningfulDeclaredWorkspacePatterns,
  getSeededBaselineGlob,
  hasImplicitWorkspaceBaseline,
  isInRepositoryWorkspacePattern,
  normalizeWorkspacePatternBody,
  resolveWorkspacePackageJsonPaths,
} from '@willbooster/shared-lib-node/src';
import fg from 'fast-glob';
import type { PackageJson } from 'type-fest';

import type { PackageConfig } from '../packageConfig.js';

// The Bun-exact resolution primitives live in @willbooster/shared-lib-node (src/bunWorkspaces.ts)
// so wb's release code shares them; re-export the ones wbfy modules and tests consume.
export {
  getDeclaredWorkspacePatterns,
  getMeaningfulDeclaredWorkspacePatterns,
  hasImplicitWorkspaceBaseline,
} from '@willbooster/shared-lib-node/src';

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
 * Every workspace package.json path (relative to the monorepo root, sorted), including manifests
 * without a `name` field — wbfy names those later, so dependency scans must not skip them.
 * Resolution mimics Bun's sequential pattern evaluation; see resolveWorkspacePackageJsonPaths.
 */
export function getWorkspacePackageJsonPaths(rootConfig: WorkspaceRootLike): string[] {
  return resolveWorkspacePackageJsonPaths(getSanitizedWorkspacePatterns(rootConfig), rootConfig.dirPath);
}

export interface WorkspaceDirPatterns {
  /** Directory subtrees (or package-owned subpaths) matched by effective negations, for tsconfig `exclude` entries. */
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
 * generated output. Negations follow Bun's sequential semantics (see
 * resolveWorkspacePackageJsonPaths): a negation stays pattern-shaped while it excludes exactly
 * what it matches, but is concretized per matched directory when a matched directory ends up a
 * workspace anyway (re-included by a later positive, a pinned concrete positive, or a seeded
 * baseline; #1005) or is an ancestor of a workspace directory, where Bun excludes only the
 * package AT that directory, so only its package-owned subpaths are excluded (#1004).
 */
export function getWorkspaceDirPatterns(rootLike: WorkspaceRootLike): WorkspaceDirPatterns {
  // Unlike discovery, generated output must not contain a never-matching `packages/*` fallback:
  // an apps/*-only monorepo would get dead globs committed into its root tsconfig. Mirror
  // applyPackageJsonConventions, which forces `packages/*` only when a manifest actually matches.
  const hasPackagesLayout =
    rootLike.doesContainSubPackageJsons &&
    // Mirror applyPackageJsonConventions' baseline gate too: with an implicit baseline seeded,
    // `packages/*` entries would be dead globs subsumed by the baseline-derived ones.
    !hasImplicitWorkspaceBaseline(rootLike.packageJson?.workspaces) &&
    fg.globSync('packages/*/package.json', {
      cwd: rootLike.dirPath,
      followSymbolicLinks: false,
      ignore: ['**/node_modules/**'],
    }).length > 0;
  const workspacePatterns = getSanitizedWorkspacePatterns({
    ...rootLike,
    doesContainSubPackageJsons: hasPackagesLayout,
  });
  const workspaceDirPaths = new Set(
    resolveWorkspacePackageJsonPaths(workspacePatterns, rootLike.dirPath).map((packageJsonPath) =>
      path.posix.dirname(packageJsonPath)
    )
  );
  const includes = new Set<string>();
  const negationBodies: string[] = [];
  for (const workspacePattern of workspacePatterns) {
    const isNegative = workspacePattern.startsWith('!');
    const patternBody = normalizeWorkspacePatternBody(isNegative ? workspacePattern.slice(1) : workspacePattern);
    if (isNegative) {
      // A seeding negation makes Bun link baseline-matched directories, so the baseline must
      // enter the generated include patterns even when every declared pattern is a negation.
      const baselineGlob = getSeededBaselineGlob(patternBody);
      if (baselineGlob !== undefined) includes.add(baselineGlob);
      negationBodies.push(patternBody);
    } else {
      for (const dirPattern of toTsconfigCompatibleDirPatterns(patternBody, rootLike.dirPath)) {
        includes.add(dirPattern);
      }
    }
  }
  const excludes = new Set<string>();
  for (const negationBody of negationBodies) {
    for (const excludeEntry of toExcludeEntries(negationBody, workspaceDirPaths, rootLike.dirPath)) {
      excludes.add(excludeEntry);
    }
  }
  return { excludes: [...excludes].toSorted(), includes: [...includes].toSorted() };
}

/**
 * tsconfig exclude entries for one negation. Pattern-shaped when the negation excludes exactly
 * what it matches (stable output); per-directory otherwise: a directory that is a workspace
 * despite the negation is not excluded at all, and neither is a PLAIN (package.json-less)
 * descendant of a workspace directory — negating a non-package directory is a no-op for Bun,
 * and the enclosing workspace stays active (e.g. `['apps/**', '!apps/**', 'apps/web']`
 * re-includes apps/web, whose src must keep type-checking; a tsconfig exclude would override
 * the include). A descendant with its own manifest that the negation keeps out of the workspace
 * set is an excluded nested package and stays excluded. A directory that is an
 * ancestor of a workspace directory gets only its package-owned subpaths excluded, because Bun
 * excludes only the package AT that directory while keeping descendant workspaces (#1004).
 */
function toExcludeEntries(negationBody: string, workspaceDirPaths: Set<string>, rootDirPath: string): string[] {
  const isWorkspaceAncestor = (dirPath: string): boolean =>
    [...workspaceDirPaths].some((workspaceDirPath) => workspaceDirPath.startsWith(`${dirPath}/`));
  // Only PLAIN directories (no package.json of their own) are protected by the enclosing
  // workspace: a matched directory that carries its own manifest yet is absent from the final
  // workspace set is an excluded nested package, and its exclusion must survive.
  const isProtectedWorkspaceDescendant = (dirPath: string): boolean =>
    [...workspaceDirPaths].some((workspaceDirPath) => dirPath.startsWith(`${workspaceDirPath}/`)) &&
    !fs.existsSync(path.join(rootDirPath, dirPath, 'package.json'));
  const matchedDirPaths = getMatchedDirPaths(negationBody, rootDirPath);
  if (
    !matchedDirPaths.some(
      (dirPath) =>
        workspaceDirPaths.has(dirPath) || isWorkspaceAncestor(dirPath) || isProtectedWorkspaceDescendant(dirPath)
    )
  ) {
    return toTsconfigCompatibleDirPatterns(negationBody, rootDirPath);
  }
  return matchedDirPaths.flatMap((dirPath) => {
    // The descendant check precedes the ancestor one: a directory inside one workspace but above
    // a nested one (e.g. apps/web/plugins between workspaces apps/web and apps/web/plugins/x)
    // still belongs to the enclosing active workspace, so nothing of it may be excluded.
    if (workspaceDirPaths.has(dirPath) || isProtectedWorkspaceDescendant(dirPath)) return [];
    if (isWorkspaceAncestor(dirPath)) {
      return [`${dirPath}/*.config.ts`, `${dirPath}/scripts`, `${dirPath}/src`, `${dirPath}/test`];
    }
    return [dirPath];
  });
}

/**
 * Directories a negation matches. The manifest-based glob complements onlyDirectories because
 * fast-glob's `dir/**` does not return `dir` itself as a directory, while both Bun and the
 * manifest glob treat `**` as zero or more segments (`apps/**` covers the package at apps).
 */
function getMatchedDirPaths(negationBody: string, rootDirPath: string): string[] {
  const globOptions = { cwd: rootDirPath, followSymbolicLinks: false, ignore: ['**/node_modules/**'] };
  return [
    ...new Set([
      ...fg.globSync(negationBody, { ...globOptions, onlyDirectories: true }),
      ...fg
        .globSync(path.posix.join(negationBody, 'package.json'), globOptions)
        .map((packageJsonPath) => path.posix.dirname(packageJsonPath))
        // A zero-segment `**` match reaches the root itself, which is never a workspace.
        .filter((dirPath) => dirPath !== '.'),
    ]),
  ].toSorted();
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
 * repository's files. Declaration order and duplicates are preserved — Bun evaluates the
 * patterns sequentially, so position matters.
 */
function getSanitizedWorkspacePatterns(rootLike: WorkspaceRootLike): string[] {
  const declaredPatterns = getMeaningfulDeclaredWorkspacePatterns(rootLike.packageJson?.workspaces);
  // applyPackageJsonConventions forces `packages/*` into a monorepo's workspaces when a
  // packages/*/package.json actually matches, but it may not have written the root package.json
  // yet, so mirror that normalization here — PREPENDED like there, because a positive pattern
  // placed after a user negation would re-include the negated packages under Bun's sequential
  // evaluation. Discovery callers pass the fallback unconditionally for monorepos — a
  // never-matching pattern contributes no paths there — while pattern-shaped callers
  // (getWorkspaceDirPatterns) gate it on an actual match.
  const workspacePatterns =
    rootLike.doesContainSubPackageJsons && !hasDeclaredPackagesStarPattern(rootLike.packageJson?.workspaces)
      ? ['packages/*', ...declaredPatterns]
      : declaredPatterns;
  return workspacePatterns.filter((workspacePattern) => isInRepositoryWorkspacePattern(workspacePattern));
}

/**
 * Whether a declared positive pattern already covers `packages/*` under path normalization
 * (e.g. `./packages/*` or a trailing-slash spelling): forcing a textual `packages/*` next to
 * such a spelling would persist duplicate equivalent patterns and re-scan the same directories.
 */
export function hasDeclaredPackagesStarPattern(workspaces: PackageJson['workspaces']): boolean {
  return getMeaningfulDeclaredWorkspacePatterns(workspaces).some(
    (workspacePattern) =>
      !workspacePattern.startsWith('!') &&
      // A `..`-traversing or absolute spelling (e.g. `x/../packages/*`) is discarded by
      // getSanitizedWorkspacePatterns, so it must not count as covering packages/* — that would
      // suppress the fallback AND lose the pattern, leaving no discovered workspaces.
      isInRepositoryWorkspacePattern(workspacePattern) &&
      normalizeWorkspacePatternBody(workspacePattern) === 'packages/*'
  );
}
