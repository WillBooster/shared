import fs from 'node:fs';
import path from 'node:path';

import fg from 'fast-glob';

/** The `workspaces` field of a root package.json: the array form or Yarn v1's object form. */
export type WorkspacesDeclaration = string[] | { packages?: string[] } | undefined;

/**
 * Every workspace package.json path (relative to the monorepo root, sorted) that Bun would link
 * for the given root package.json `workspaces` declaration. Canonicalizes the declared patterns
 * (see getMeaningfulDeclaredWorkspacePatterns), drops patterns escaping the repository (see
 * isInRepositoryWorkspacePattern), and resolves the rest with Bun's sequential semantics (see
 * resolveWorkspacePackageJsonPaths).
 */
export function resolveBunWorkspacePackageJsonPaths(workspaces: WorkspacesDeclaration, rootDirPath: string): string[] {
  return resolveWorkspacePackageJsonPaths(
    getMeaningfulDeclaredWorkspacePatterns(workspaces).filter((workspacePattern) =>
      isInRepositoryWorkspacePattern(workspacePattern)
    ),
    rootDirPath
  );
}

/**
 * Resolves workspace patterns to package.json paths mimicking Bun's SEQUENTIAL evaluation,
 * derived empirically with Bun 1.3.14 (fixture repos observed via `bun install --lockfile-only`;
 * WillBooster/shared#1004 / WillBooster/shared#1005):
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
 *    `!**\/*`, `!a/b/*`, `!a/b/**`, `!dir`, and `!dir/*x` each link nothing on their own.
 *    `?`, brace, and character-class last segments behave ERRATICALLY (`["!other/?"]` links
 *    packages/a yet not the equally baseline-shaped other/yy, `["!other/??"]` links nothing, and
 *    `["!?/?"]` links the very other/x it matches), so no consistent rule can model them; they
 *    are deliberately treated as not seeding — see hasImplicitWorkspaceBaseline and #1005.
 * 3. A non-glob positive pattern PINS its directory: it stays a workspace regardless of where a
 *    matching negation appears (`["other/x", "!other/x"]` and `["!other/x", "other/x"]` both
 *    link other/x).
 * 4. `**` matches zero or more path segments (`["apps/**"]` links the package at apps itself, and
 *    `!apps/**` deletes it), matching fast-glob's file-glob semantics.
 * Do not apply globIgnore here: workspace membership is defined solely by the declared patterns,
 * and source-scanning ignores such as `build` or `dist` would hide legitimately named workspace
 * directories.
 */
export function resolveWorkspacePackageJsonPaths(workspacePatterns: string[], rootDirPath: string): string[] {
  // followSymbolicLinks: false stops GLOB traversal through symlinks, but a non-glob pattern
  // naming a symlinked directory (e.g. `linked` with `linked -> ../other-repo`) still matches —
  // fast-glob resolves static patterns with direct fs checks, and Bun does link such a workspace.
  // Deliberately diverge from Bun there: consumers such as node_modules cleanup and manifest
  // rewriting would otherwise delete and rewrite files in ANOTHER repository through the symlink,
  // so keep only manifests whose real path stays inside the repository's real root. Scanning each
  // pattern separately (no cross-pattern caching) is deliberate: declarations hold a handful of
  // patterns, so a cache would complicate this shared code without measurable gain.
  let realRootDirPath: string | undefined;
  const isInsideRealRoot = (packageJsonPath: string): boolean => {
    try {
      realRootDirPath ??= fs.realpathSync(rootDirPath);
      const relativePath = path.relative(realRootDirPath, fs.realpathSync(path.join(rootDirPath, packageJsonPath)));
      // Compare whole segments, not a `..` prefix: a directory literally named e.g. `..pkg` is
      // inside the root, while a plain startsWith('..') would misread it as parent traversal.
      return relativePath !== '..' && !relativePath.startsWith(`..${path.sep}`) && !path.isAbsolute(relativePath);
    } catch {
      // A manifest that vanished between the glob and the realpath call is not a workspace.
      return false;
    }
  };
  const globManifestPaths = (pattern: string): string[] => {
    // Bun links dot-directory packages only through fully static patterns: with Bun 1.3.14,
    // `.hidden/x` pins the package while `.hidden/*`, `.*/*`, and `**` all link nothing under
    // .hidden — even when the dotted segment itself is literal — so any dynamic pattern must
    // drop matches containing a dot-led segment (fast-glob's `dot: false` only covers segments
    // a wildcard matches).
    const excludesDotSegments = fg.isDynamicPattern(pattern);
    return (
      fg
        .globSync(path.posix.join(pattern, 'package.json'), {
          cwd: rootDirPath,
          followSymbolicLinks: false,
          ignore: ['**/node_modules/**'],
        })
        // A zero-segment `**` match reaches the root's own manifest, but Bun never treats the
        // monorepo root as its own workspace.
        .filter(
          (packageJsonPath) =>
            packageJsonPath !== 'package.json' &&
            (!excludesDotSegments || !packageJsonPath.split('/').some((segment) => segment.startsWith('.'))) &&
            isInsideRealRoot(packageJsonPath)
        )
    );
  };
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

/**
 * Whether the declaration seeds Bun's implicit workspace baseline: it contains at least one
 * negation of the seeding shape (see resolveWorkspacePackageJsonPaths rule 2). Measured with Bun
 * 1.3.14, seeding is per-negation and happens even alongside positive patterns; concrete or
 * mixed-literal last segments (`!apps/excluded`, `!apps/*d`) never seed, and `?`, brace, and
 * character-class last segments behaved inconsistently across fixtures (sometimes dropping even
 * unrelated sibling workspaces), so they are conservatively treated as not seeding; see
 * WillBooster/shared#1005.
 */
export function hasImplicitWorkspaceBaseline(workspaces: WorkspacesDeclaration): boolean {
  return getMeaningfulDeclaredWorkspacePatterns(workspaces).some(
    (workspacePattern) =>
      workspacePattern.startsWith('!') &&
      getSeededBaselineGlob(normalizeWorkspacePatternBody(workspacePattern.slice(1))) !== undefined
  );
}

/**
 * Declared workspace patterns without Bun's no-op ones (`""`, a lone `"!"`, and `"."`), which Bun
 * ignores entirely — a lone `"!"` must not activate the negative-only implicit baseline, and `""`
 * must not make the repository root itself a discovered workspace. Declaration order and
 * duplicates are preserved — Bun evaluates the patterns sequentially, so position matters.
 */
export function getMeaningfulDeclaredWorkspacePatterns(workspaces: WorkspacesDeclaration): string[] {
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

/**
 * Collapses `//`, resolves `./`, and strips trailing slashes, mirroring Bun's path handling.
 * A pure star-run segment of three or more stars behaves like `*` under Bun (`!other/***`
 * matches other/x) but not under fast-glob, so canonicalize it to `*`.
 */
export function normalizeWorkspacePatternBody(patternBody: string): string {
  return path.posix
    .normalize(patternBody)
    .replace(/\/+$/u, '')
    .split('/')
    .map((segment) => (/^\*{3,}$/u.test(segment) ? '*' : segment))
    .join('/');
}

/** The implicit baseline glob a negation seeds under Bun's rule 2 above, or undefined if none. */
export function getSeededBaselineGlob(negationBody: string): string | undefined {
  const segments = negationBody.split('/');
  if (segments.length !== 2) return undefined;
  const [firstSegment, lastSegment] = segments as [string, string];
  if (!/^\*+$/u.test(lastSegment) || /^\*+$/u.test(firstSegment)) return undefined;
  return lastSegment === '**' ? '**' : '*/*';
}

/** Workspace patterns from either the array form or Yarn v1's `{ packages: […] }` object form. */
export function getDeclaredWorkspacePatterns(workspaces: WorkspacesDeclaration): string[] {
  if (Array.isArray(workspaces)) return workspaces;
  return Array.isArray(workspaces?.packages) ? workspaces.packages : [];
}

/**
 * Whether a declared workspace pattern (negative ones included) stays inside the repository:
 * absolute or `..`-traversing patterns would make consumers such as node_modules cleanup operate
 * on another repository's files.
 */
export function isInRepositoryWorkspacePattern(workspacePattern: string): boolean {
  const patternBody = workspacePattern.startsWith('!') ? workspacePattern.slice(1) : workspacePattern;
  return !path.posix.isAbsolute(patternBody) && !patternBody.split('/').includes('..');
}
