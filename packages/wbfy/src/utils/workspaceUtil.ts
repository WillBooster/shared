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
 * despite the negation is not excluded at all, and a directory that is an ancestor of a workspace
 * directory gets only its package-owned subpaths excluded, because Bun excludes only the package
 * AT that directory while keeping descendant workspaces (#1004).
 */
function toExcludeEntries(negationBody: string, workspaceDirPaths: Set<string>, rootDirPath: string): string[] {
  const isWorkspaceAncestor = (dirPath: string): boolean =>
    [...workspaceDirPaths].some((workspaceDirPath) => workspaceDirPath.startsWith(`${dirPath}/`));
  const matchedDirPaths = getMatchedDirPaths(negationBody, rootDirPath);
  if (!matchedDirPaths.some((dirPath) => workspaceDirPaths.has(dirPath) || isWorkspaceAncestor(dirPath))) {
    return toTsconfigCompatibleDirPatterns(negationBody, rootDirPath);
  }
  return matchedDirPaths.flatMap((dirPath) => {
    if (workspaceDirPaths.has(dirPath)) return [];
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
 * Resolves workspace patterns to package.json paths mimicking Bun's SEQUENTIAL evaluation,
 * derived empirically with Bun 1.3.14 (fixture repos observed via `bun install --lockfile-only`;
 * #1004/#1005):
 * 1. Patterns are evaluated in declaration order into an accumulating set: a positive glob
 *    pattern adds every package.json it matches; a negation deletes its matches from the set
 *    accumulated SO FAR, so a later positive re-adds them (`["!apps/excluded", "apps/*"]` links
 *    apps/excluded, while `["apps/*", "!apps/excluded"]` does not).
 * 2. A negation whose normalized body has EXACTLY two segments, whose last segment is a star-run
 *    (`*`, `**`, `***`, …), and whose first segment is NOT itself a star-run first seeds the
 *    implicit baseline into the set, then deletes its own matches: a `**` last segment seeds
 *    `**` (packages at any depth), any other star-run seeds `*\/*` (depth 2 only). Seeding
 *    happens even alongside positive patterns (`["apps/*", "!other/*"]` links every depth-2
 *    package outside other/). No other negation shape seeds: `!*`, `!**`, `!*\/*`, `!*\/**`,
 *    `!**\/*`, `!a/b/*`, `!a/b/**`, `!dir`, `!dir/?`, and `!dir/*x` each link nothing on their
 *    own.
 * 3. A non-glob positive pattern PINS its directory: it stays a workspace regardless of where a
 *    matching negation appears (`["other/x", "!other/x"]` and `["!other/x", "other/x"]` both
 *    link other/x).
 * 4. `**` matches zero or more path segments (`["apps/**"]` links the package at apps itself, and
 *    `!apps/**` deletes it), matching fast-glob's file-glob semantics.
 * Do not apply globIgnore here: workspace membership is defined solely by the declared patterns,
 * and source-scanning ignores such as `build` or `dist` would hide legitimately named workspace
 * directories.
 */
function resolveWorkspacePackageJsonPaths(workspacePatterns: string[], rootDirPath: string): string[] {
  // followSymbolicLinks: false — a workspace symlink pointing outside the repository must not be
  // treated as a workspace directory (removeNodeModules would delete through it).
  const globManifestPaths = (pattern: string): string[] =>
    fg
      .globSync(path.posix.join(pattern, 'package.json'), {
        cwd: rootDirPath,
        followSymbolicLinks: false,
        ignore: ['**/node_modules/**'],
      })
      // A zero-segment `**` match reaches the root's own manifest, but Bun never treats the
      // monorepo root as its own workspace.
      .filter((packageJsonPath) => packageJsonPath !== 'package.json');
  const accumulatedPaths = new Set<string>();
  const pinnedPaths = new Set<string>();
  for (const workspacePattern of workspacePatterns) {
    const isNegative = workspacePattern.startsWith('!');
    const patternBody = normalizeWorkspacePatternBody(isNegative ? workspacePattern.slice(1) : workspacePattern);
    if (isNegative) {
      const baselineGlob = getSeededBaselineGlob(patternBody);
      if (baselineGlob !== undefined) {
        for (const packageJsonPath of globManifestPaths(baselineGlob)) accumulatedPaths.add(packageJsonPath);
      }
      for (const packageJsonPath of globManifestPaths(patternBody)) accumulatedPaths.delete(packageJsonPath);
    } else {
      for (const packageJsonPath of globManifestPaths(patternBody)) {
        (fg.isDynamicPattern(patternBody) ? accumulatedPaths : pinnedPaths).add(packageJsonPath);
      }
    }
  }
  return [...new Set([...accumulatedPaths, ...pinnedPaths])].toSorted();
}

/** The implicit baseline glob a negation seeds under Bun's rule 2 above, or undefined if none. */
function getSeededBaselineGlob(negationBody: string): string | undefined {
  const segments = negationBody.split('/');
  if (segments.length !== 2) return undefined;
  const [firstSegment, lastSegment] = segments as [string, string];
  if (!/^\*+$/u.test(lastSegment) || /^\*+$/u.test(firstSegment)) return undefined;
  return lastSegment === '**' ? '**' : '*/*';
}

/**
 * Collapses `//`, resolves `./`, and strips trailing slashes, mirroring Bun's path handling.
 * A pure star-run segment of three or more stars behaves like `*` under Bun (`!other/***`
 * matches other/x) but not under fast-glob, so canonicalize it to `*`.
 */
function normalizeWorkspacePatternBody(patternBody: string): string {
  return path.posix
    .normalize(patternBody)
    .replace(/\/+$/u, '')
    .split('/')
    .map((segment) => (/^\*{3,}$/u.test(segment) ? '*' : segment))
    .join('/');
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
    rootLike.doesContainSubPackageJsons && !declaredPatterns.includes('packages/*')
      ? ['packages/*', ...declaredPatterns]
      : declaredPatterns;
  return workspacePatterns.filter((workspacePattern) => {
    const patternBody = workspacePattern.startsWith('!') ? workspacePattern.slice(1) : workspacePattern;
    return !path.posix.isAbsolute(patternBody) && !patternBody.split('/').includes('..');
  });
}

/**
 * Whether the declaration seeds Bun's implicit workspace baseline: it contains at least one
 * negation of the seeding shape (see resolveWorkspacePackageJsonPaths rule 2). Measured with Bun
 * 1.3.14, seeding is per-negation and happens even alongside positive patterns; concrete or
 * mixed-literal last segments (`!apps/excluded`, `!apps/*d`) never seed, and `?`, brace, and
 * character-class last segments behaved inconsistently across fixtures (sometimes dropping even
 * unrelated sibling workspaces), so they are conservatively treated as not seeding; see #1005.
 */
export function hasImplicitWorkspaceBaseline(workspaces: PackageJson['workspaces']): boolean {
  return getMeaningfulDeclaredWorkspacePatterns(workspaces).some(
    (workspacePattern) =>
      workspacePattern.startsWith('!') &&
      getSeededBaselineGlob(normalizeWorkspacePatternBody(workspacePattern.slice(1))) !== undefined
  );
}

/**
 * Declared workspace patterns without Bun's no-op ones (`""`, a lone `"!"`, and `"."`), which Bun
 * ignores entirely — a lone `"!"` must not activate the negative-only implicit baseline, and `""`
 * must not make the repository root itself a discovered workspace.
 */
export function getMeaningfulDeclaredWorkspacePatterns(workspaces: PackageJson['workspaces']): string[] {
  return getDeclaredWorkspacePatterns(workspaces)
    .map((workspacePattern) => {
      // Bun applies leading-bang PARITY (verified with Bun 1.3.14): `!!p` is the positive `p`
      // and `!!!p` the negation `!p`, so canonicalize to at most one bang.
      const bangCount = /^!*/u.exec(workspacePattern)![0].length;
      const patternBody = workspacePattern.slice(bangCount);
      return bangCount % 2 === 1 ? `!${patternBody}` : patternBody;
    })
    .filter((workspacePattern) => {
      const patternBody = workspacePattern.startsWith('!') ? workspacePattern.slice(1) : workspacePattern;
      // Normalize so spellings like `./`, `./.`, and `!./` are recognized as the same no-ops
      // (path.posix.normalize('') === '.', so the empty pattern is covered too).
      return normalizeWorkspacePatternBody(patternBody) !== '.';
    });
}

/** Workspace patterns from either the array form or Yarn v1's `{ packages: […] }` object form. */
export function getDeclaredWorkspacePatterns(workspaces: PackageJson['workspaces']): string[] {
  if (Array.isArray(workspaces)) return workspaces;
  return Array.isArray(workspaces?.packages) ? workspaces.packages : [];
}
