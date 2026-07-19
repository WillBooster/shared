import fs from 'node:fs';
import path from 'node:path';

import merge from 'deepmerge';
import type { PackageJson, TsConfigJson } from 'type-fest';

import { logger } from '../logger.js';
import type { PackageConfig } from '../packageConfig.js';
import { fsUtil } from '../utils/fsUtil.js';
import { jsoncUtil } from '../utils/jsoncUtil.js';
import { combineMerge } from '../utils/mergeUtil.js';
import { sortKeys } from '../utils/objectUtil.js';
import { promisePool } from '../utils/promisePool.js';
import { getTsconfigExtends } from '../utils/tsconfigBase.js';
import { getDeclaredWorkspacePatterns, getWorkspaceDirPatterns } from '../utils/workspaceUtil.js';

const subJsonObj = {
  compilerOptions: {
    alwaysStrict: true,
    noUncheckedIndexedAccess: true, // for @typescript-eslint/prefer-nullish-coalescing
    allowSyntheticDefaultImports: true, // allow `import React from 'react'`
    esModuleInterop: true, // allow default import from CommonJS/AMD/UMD modules
    resolveJsonModule: true, // allow to import JSON files
    importHelpers: false,
    noEmit: true,
  },
  exclude: ['test/fixtures'],
  // wbfy generates root-level tool configs such as playwright.config.ts, and
  // type-aware linting needs those files in the project to see Node/Bun globals.
  // `app/**` is deliberately absent even though the doesContain*Script signals scan it: app
  // directories belong to framework packages (Next.js/Blitz), which own their tsconfig
  // (generateTsconfig skips them), and checking framework sources under this project's compiler
  // options would produce false errors.
  include: ['*.config.ts', 'scripts/**/*', 'src/**/*', 'test/**/*'],
};

export async function generateTsconfig(config: PackageConfig): Promise<void> {
  return logger.functionIgnoringException('generateTsconfig', async () => {
    if (config.depending.blitz || config.depending.next) {
      await cleanupLegacyTsconfigModuleSettings(config);
      return;
    }

    let newSettings = (config.isRoot ? buildRootJsonObj(config) : structuredClone(subJsonObj)) as TsConfigJson;
    const generatedTypes = getGeneratedTypes(config);
    newSettings.extends = getTsconfigExtends(config);
    newSettings.compilerOptions ??= {};
    newSettings.compilerOptions.rootDir = getRootDir(config);
    if (generatedTypes.length > 0) {
      newSettings.compilerOptions = { ...newSettings.compilerOptions, types: generatedTypes };
    }
    if (!config.doesContainJsxOrTsx && !config.doesContainJsxOrTsxInPackages) {
      delete newSettings.compilerOptions?.jsx;
    }
    if (config.depending.prisma) {
      // Prisma seeds and migration helper scripts often live outside src, but
      // type-aware linting still needs them covered by the project config.
      addIncludePath(newSettings, 'prisma/**/*');
    }

    const filePath = path.resolve(config.dirPath, 'tsconfig.json');
    const existingContent = await fsUtil.readFileIfExists(filePath);
    let originalSettingsJson: string | undefined;
    // A file with no configuration (empty or comment-only) is treated like a missing one, as tsc does.
    if (existingContent !== undefined && !jsoncUtil.isTriviaOnly(existingContent)) {
      const oldSettings = jsoncUtil.parseObjectIgnoringError<TsConfigJson>(existingContent);
      // An existing tsconfig.json wbfy cannot parse must be left untouched: writing the
      // generated settings without merging would silently discard the project's configuration.
      if (!oldSettings) {
        console.warn(`Skipped generating ${filePath} because the existing content is not parsable as JSONC.`);
        return;
      }
      originalSettingsJson = JSON.stringify(sortKeys(structuredClone(oldSettings)));
      const existingTypes = normalizeStringArray(oldSettings.compilerOptions?.types);
      const existingEmitMetadata = pickExistingEmitMetadata(oldSettings.compilerOptions);
      newSettings.extends = mergeTsconfigExtends(newSettings.extends, oldSettings.extends);
      delete oldSettings.extends;
      delete oldSettings.compilerOptions?.jsx;
      if (config.isRoot) {
        removeStaleManagedWorkspaceEntries(config, oldSettings, newSettings);
      }
      newSettings = merge.all([newSettings, oldSettings, newSettings], { arrayMerge: combineMerge });
      newSettings.include = newSettings.include?.filter(
        (dirPath: string) =>
          !dirPath.includes('@types') && !dirPath.includes('__tests__/') && !dirPath.includes('tests/')
      );
      newSettings.compilerOptions ??= {};
      // wbfy-generated tsconfig.json is a lint/typecheck project, not the emit
      // contract. It must keep rootDir broad enough for root config files,
      // scripts, src, and tests. build-ts owns emit and creates a temporary
      // src-only tsconfig with noEmit=false, emitDeclarationOnly=true,
      // rootDir="src", and include=["src/**/*"], so preserving noEmit=false or
      // rootDir="src" here would only break non-src type-aware lint coverage.
      newSettings.compilerOptions = { ...newSettings.compilerOptions, ...existingEmitMetadata };

      const mergedTypes = [...new Set([...filterExistingTypes(existingTypes, generatedTypes), ...generatedTypes])];
      if (mergedTypes.length > 0) {
        newSettings.compilerOptions.types = mergedTypes;
      } else {
        delete newSettings.compilerOptions.types;
      }
      if (shouldDeleteTypeRoots(generatedTypes)) {
        delete newSettings.compilerOptions.typeRoots;
      }
    }
    addUndiciTypesPathMapping(newSettings, config);
    sortKeys(newSettings);
    newSettings.include?.sort();
    // Don't use old decorator
    delete newSettings.compilerOptions?.experimentalDecorators;
    // Package imports should resolve through package exports instead of baseUrl.
    // paths is intentionally preserved so repo-local tooling can keep explicit
    // aliases without relying on baseUrl's broad fallback resolution.
    delete newSettings.compilerOptions?.baseUrl;
    deleteLegacyModuleSettings(newSettings.compilerOptions);
    if (config.depending.reactNative) {
      delete newSettings.compilerOptions?.verbatimModuleSyntax;
    }
    // Skip the write when nothing changes semantically, so JSONC comments and formatting in an
    // already-up-to-date tsconfig.json survive wbfy runs.
    if (originalSettingsJson === JSON.stringify(newSettings)) return;
    const newContent = JSON.stringify(newSettings, undefined, 2);
    await promisePool.run(() => fsUtil.generateFile(filePath, newContent));
  });
}

/**
 * The monorepo-root tsconfig, whose include/exclude cover every DECLARED workspace layout (e.g.
 * `apps/*` alongside `packages/*`) so type-aware linting run from the root sees all workspace
 * sources, not just the conventional packages/* directory.
 */
function buildRootJsonObj(config: PackageConfig): TsConfigJson {
  const workspacePatterns = config.doesContainSubPackageJsons
    ? getWorkspaceDirPatterns(config)
    : { excludes: [], includes: [] };
  const settings = structuredClone(subJsonObj) as TsConfigJson;
  settings.exclude = [
    ...new Set([
      ...workspacePatterns.includes.map((workspacePattern) => `${workspacePattern}/test/fixtures`),
      // Negative workspace patterns (e.g. `!packages/excluded`) opt whole workspace subtrees out
      // of the monorepo, so their sources must not enter the root type-check project either.
      ...workspacePatterns.excludes,
      ...(settings.exclude ?? []),
    ]),
  ].toSorted();
  settings.include = [
    ...(settings.include ?? []),
    ...workspacePatterns.includes.flatMap((workspacePattern) => [
      `${workspacePattern}/*.config.ts`,
      `${workspacePattern}/scripts/**/*`,
      `${workspacePattern}/src/**/*`,
      `${workspacePattern}/test/**/*`,
    ]),
  ];
  return settings;
}

const managedWorkspaceIncludeSuffixes = ['*.config.ts', 'scripts/**/*', 'src/**/*', 'test/**/*'];

/**
 * Root include/exclude entries wbfy generated for an earlier workspace layout (e.g. `packages/*`
 * globs in a repo that now declares only `apps/*`) must not survive the merge with the existing
 * tsconfig, or the obsolete directories would keep entering root type checking forever. A prefix
 * counts as wbfy-managed only when the COMPLETE generated include set for it is present and no
 * longer generated — a user-authored entry such as a lone `tools/*\/src/**\/*` never qualifies.
 */
function removeStaleManagedWorkspaceEntries(
  config: PackageConfig,
  oldSettings: TsConfigJson,
  newSettings: TsConfigJson
): void {
  const stalePrefixes = new Set<string>();
  if (Array.isArray(oldSettings.include)) {
    const oldInclude = oldSettings.include.filter((entry): entry is string => typeof entry === 'string');
    const generatedInclude = new Set(newSettings.include);
    for (const entry of oldInclude) {
      const workspacePrefix = getManagedWorkspacePrefix(entry);
      if (workspacePrefix === undefined || stalePrefixes.has(workspacePrefix)) continue;
      const isComplete = managedWorkspaceIncludeSuffixes.every((suffix) =>
        oldInclude.includes(`${workspacePrefix}/${suffix}`)
      );
      const isStillGenerated = managedWorkspaceIncludeSuffixes.some((suffix) =>
        generatedInclude.has(`${workspacePrefix}/${suffix}`)
      );
      if (isComplete && !isStillGenerated) stalePrefixes.add(workspacePrefix);
    }
    if (stalePrefixes.size > 0) {
      oldSettings.include = oldSettings.include.filter((entry) => {
        const workspacePrefix = typeof entry === 'string' ? getManagedWorkspacePrefix(entry) : undefined;
        return workspacePrefix === undefined || !stalePrefixes.has(workspacePrefix);
      });
    }
  }
  if (!Array.isArray(oldSettings.exclude)) return;
  const generatedExclude = new Set(newSettings.exclude);
  const workspaceIncludePatterns = config.doesContainSubPackageJsons ? getWorkspaceDirPatterns(config).includes : [];
  oldSettings.exclude = oldSettings.exclude.filter((entry) => {
    if (typeof entry !== 'string' || generatedExclude.has(entry)) return true;
    if (entry.endsWith('/test/fixtures')) {
      return !stalePrefixes.has(entry.slice(0, -'/test/fixtures'.length));
    }
    // A negation-derived exclude whose `!pattern` was removed from `workspaces`: the directory is
    // covered by a positive workspace pattern again and must re-enter the root project. A user
    // who wants such a directory excluded permanently should keep the workspace negation, which
    // regenerates the entry on every run. The check runs in both directions because either side
    // can be the pattern: the entry may be wildcard-shaped (a negation like `!apps/excluded/*`)
    // while the current includes are concrete (expanded from Bun-only glob syntax), or vice versa.
    return !(
      isCoveredByWorkspaceDirPattern(entry, workspaceIncludePatterns) ||
      workspaceIncludePatterns.some((includePattern) => isCoveredByWorkspaceDirPattern(includePattern, [entry]))
    );
  });
}

/** Matches a concrete directory path against tsconfig-safe workspace dir patterns (`*`, `?`, `**`). */
function isCoveredByWorkspaceDirPattern(dirPath: string, workspacePatterns: string[]): boolean {
  return workspacePatterns.some((workspacePattern) => {
    // `**` matches ZERO or more path segments (`apps/**` covers `apps` itself), matching the
    // fast-glob/Bun semantics workspace discovery uses; the placeholder dance makes the adjacent
    // separator optional.
    const globStarPlaceholder = '\u0000';
    const regexSource = workspacePattern
      .split('/')
      .map((segment) =>
        segment === '**'
          ? globStarPlaceholder
          : segment
              .replaceAll(/[.+^${}()|[\]\\]/gu, String.raw`\$&`)
              .replaceAll('*', '[^/]*')
              .replaceAll('?', '[^/]')
      )
      .join('/')
      .replaceAll(`/${globStarPlaceholder}`, '(?:/.+)?')
      .replaceAll(`${globStarPlaceholder}/`, '(?:.+/)?')
      .replaceAll(globStarPlaceholder, '.*');
    return new RegExp(`^${regexSource}$`, 'u').test(dirPath);
  });
}

function getManagedWorkspacePrefix(entry: string): string | undefined {
  const matchedSuffix = managedWorkspaceIncludeSuffixes.find((suffix) => entry.endsWith(`/${suffix}`));
  if (!matchedSuffix) return undefined;
  const workspacePrefix = entry.slice(0, -(matchedSuffix.length + 1));
  return workspacePrefix === '' ? undefined : workspacePrefix;
}

async function cleanupLegacyTsconfigModuleSettings(config: PackageConfig): Promise<void> {
  // Next/Blitz own their tsconfig shape, but TypeScript 6 no longer accepts
  // node10 resolver spellings that older projects commonly inherited.
  const filePath = path.resolve(config.dirPath, 'tsconfig.json');
  const existingContent = await fsUtil.readFileIfExists(filePath);
  if (existingContent === undefined || jsoncUtil.isTriviaOnly(existingContent)) return;
  const settings = jsoncUtil.parseObjectIgnoringError<TsConfigJson>(existingContent);
  if (!settings) {
    console.warn(`Skipped cleaning up ${filePath} because the existing content is not parsable as JSONC.`);
    return;
  }
  const originalSettingsJson = JSON.stringify(settings);
  normalizeNextTsconfigModuleSettings(settings);
  normalizeNextTsconfigPathAliases(settings.compilerOptions);
  addScriptsIncludeForFrameworkProject(settings);
  addUndiciTypesPathMapping(settings, config);
  // Skip the write when nothing changes semantically, so JSONC comments and formatting in an
  // already-clean tsconfig.json survive wbfy runs.
  if (JSON.stringify(settings) === originalSettingsJson) return;
  await promisePool.run(() => fsUtil.generateFile(filePath, JSON.stringify(settings, undefined, 2)));
}

/**
 * bun-types references undici-types without declaring it as a dependency (oven-sh/bun#22805), so
 * Bun's isolated linker (especially with the global store outside the repository) cannot resolve
 * it from bun-types' location, which silently degrades global fetch types such as Response. Map it
 * to the copy that bunfig.toml's publicHoistPattern places in the root node_modules.
 */
function addUndiciTypesPathMapping(settings: TsConfigJson, config: PackageConfig): void {
  // Map undici-types only when bun-types actually loads: an explicit `types` list loads it iff it
  // contains "bun" (even on React Native, whose projects may opt in by hand); with `types`
  // omitted, TypeScript's automatic @types inclusion loads it because wbfy installs @types/bun
  // for every TypeScript project except React Native, which uses @tsconfig/react-native instead.
  const types = settings.compilerOptions?.types;
  if (types ? !types.includes('bun') : config.depending.reactNative) return;
  const correctMapping = `${getRootDir(config)}/node_modules/undici-types/index.d.ts`;
  const existingMapping = settings.compilerOptions?.paths?.['undici-types'];
  if (existingMapping) {
    // Rewrite any mapping wbfy could have generated — a `…/node_modules/undici-types` target with
    // or without the concrete index.d.ts, at whatever root depth an older getRootDir computed
    // (its fixed two-level probe mis-resolved workspaces deeper than two levels). Any other value
    // is a deliberate repo-local mapping (e.g. patched types) and must be kept.
    if (
      existingMapping.length === 1 &&
      typeof existingMapping[0] === 'string' &&
      /(?:^|\/)node_modules\/undici-types(?:\/index\.d\.ts)?$/u.test(existingMapping[0])
    ) {
      settings.compilerOptions!.paths!['undici-types'] = [correctMapping];
    }
    return;
  }

  settings.compilerOptions ??= {};
  settings.compilerOptions.paths = {
    ...settings.compilerOptions.paths,
    'undici-types': [correctMapping],
  };
}

function addScriptsIncludeForFrameworkProject(settings: TsConfigJson): void {
  // Omitting include lets framework tsconfigs keep TypeScript's default
  // "all TS/TSX files" behavior, which already covers scripts.
  if (!settings.include) return;
  if (settings.include.includes('scripts/**/*')) return;

  settings.include.push('scripts/**/*');
  settings.include.sort();
}

function normalizeNextTsconfigModuleSettings(settings: TsConfigJson): void {
  const compilerOptions = settings.compilerOptions;
  if (!compilerOptions) return;
  const moduleResolution = lowerCaseSetting(compilerOptions.moduleResolution);
  if (moduleResolution === 'node' || moduleResolution === 'node10' || moduleResolution === undefined) {
    if (settings.extends) {
      // An extended config may already supply a valid module/resolver pair, so only
      // remove the removed-in-TS6 node10 spellings instead of forcing bundler on it.
      delete compilerOptions.moduleResolution;
    } else {
      // Next.js writes "node" during build when this option is missing, but
      // tsgolint treats that spelling as the removed node10 resolver.
      compilerOptions.moduleResolution = 'bundler';
    }
  }
}

function normalizeNextTsconfigPathAliases(compilerOptions: TsConfigJson.CompilerOptions | undefined): void {
  if (!compilerOptions) return;

  // tsgolint follows TypeScript 6 validation, where baseUrl is removed and
  // path targets must be explicitly relative. Next.js still accepts the alias
  // shape after each target is written with a leading ./.
  delete compilerOptions.baseUrl;
  if (!compilerOptions.paths) return;

  for (const [alias, targets] of Object.entries(compilerOptions.paths)) {
    compilerOptions.paths[alias] = normalizePathAliasTargets(targets);
  }
}

function normalizePathAliasTargets(targets: string[]): string[] {
  return targets.map((target) => {
    if (target.startsWith('./') || target.startsWith('../') || path.isAbsolute(target)) return target;
    return `./${target}`;
  });
}

function getRootDir(config: PackageConfig): string {
  if (config.isRoot) return '.';
  // The undici-types path mapping must reach the monorepo root's node_modules (bunfig.toml's
  // publicHoistPattern hoists the package there), and workspace patterns may be arbitrarily deep
  // (e.g. `examples/**`), so a fixed two-level probe is not enough. Prefer the nearest ancestor
  // manifest that declares workspaces (the monorepo root); otherwise fall back to the nearest
  // ancestor manifest. Stop at the first git repository boundary so an unrelated enclosing
  // repository's manifest can never be chosen.
  const dirPath = path.resolve(config.dirPath);
  let rootDirPath: string | undefined;
  for (let ancestorDirPath = path.dirname(dirPath); ; ancestorDirPath = path.dirname(ancestorDirPath)) {
    const manifestPath = path.resolve(ancestorDirPath, 'package.json');
    if (fs.existsSync(manifestPath)) {
      rootDirPath ??= ancestorDirPath;
      try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as PackageJson;
        if (getDeclaredWorkspacePatterns(manifest.workspaces).length > 0) {
          rootDirPath = ancestorDirPath;
          break;
        }
      } catch {
        // An unparsable manifest still marks a project directory; keep climbing for a workspace root.
      }
    }
    const isRepoBoundary = fs.existsSync(path.resolve(ancestorDirPath, '.git'));
    const isFilesystemRoot = ancestorDirPath === path.dirname(ancestorDirPath);
    if (isRepoBoundary || isFilesystemRoot) break;
  }
  if (!rootDirPath) return '.';
  return path.relative(dirPath, rootDirPath).replaceAll('\\', '/') || '.';
}

function mergeTsconfigExtends(
  generatedExtends: TsConfigJson['extends'],
  existingExtends: TsConfigJson['extends']
): TsConfigJson['extends'] {
  const mergedExtends = [...normalizeExtends(generatedExtends), ...normalizeExtends(existingExtends)];
  const uniqueExtends = [...new Set(mergedExtends)];
  if (uniqueExtends.length === 0) return undefined;
  if (uniqueExtends.length === 1) return uniqueExtends[0];
  return uniqueExtends;
}

function addIncludePath(settings: TsConfigJson, dirPath: string): void {
  settings.include ??= [];
  if (!settings.include.includes(dirPath)) {
    settings.include.push(dirPath);
  }
}

function normalizeExtends(value: TsConfigJson['extends']): string[] {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function normalizeStringArray(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

function shouldDeleteTypeRoots(typeNames: string[]): boolean {
  // Only generated package-owned test types should trigger this. User-defined slash-based
  // entries may intentionally rely on custom typeRoots and should be preserved as-is.
  return typeNames.some((typeName) => typeName === 'cypress' || typeName.includes('/'));
}

function filterExistingTypes(existingTypes: string[], generatedTypes: string[]): string[] {
  const generatedTypeSet = new Set(generatedTypes);
  return existingTypes.filter((typeName) => {
    // wbfy owns these package-provided test globals. Drop stale entries when the
    // corresponding dependency is no longer present so TypeScript won't require
    // missing packages such as vitest.
    if (isGeneratedTestGlobalType(typeName) && !generatedTypeSet.has(typeName)) return false;
    return true;
  });
}

function isGeneratedTestGlobalType(typeName: string): boolean {
  return typeName === 'cypress' || typeName === 'jest' || typeName === 'mocha' || typeName === 'vitest/globals';
}

function deleteLegacyModuleSettings(compilerOptions: TsConfigJson.CompilerOptions | undefined): void {
  if (!compilerOptions) return;

  // TypeScript treats option values case-insensitively, so normalize before comparison.
  const moduleResolution = lowerCaseSetting(compilerOptions.moduleResolution);
  // TypeScript 6 removed the old node10 resolver spelling, so inherited base configs
  // should choose the resolver unless a project already opted into a modern one.
  if (moduleResolution === 'node' || moduleResolution === 'node10') {
    delete compilerOptions.moduleResolution;
  }
}

function lowerCaseSetting(value: unknown): string | undefined {
  return typeof value === 'string' ? value.toLowerCase() : undefined;
}

function pickExistingEmitMetadata(
  compilerOptions: TsConfigJson['compilerOptions']
): Pick<NonNullable<TsConfigJson['compilerOptions']>, 'declaration' | 'declarationMap' | 'sourceMap'> {
  const emitOptions = {} as Pick<
    NonNullable<TsConfigJson['compilerOptions']>,
    'declaration' | 'declarationMap' | 'sourceMap'
  >;
  for (const key of ['declaration', 'declarationMap', 'sourceMap'] as const) {
    const value = compilerOptions?.[key];
    if (value !== undefined) {
      emitOptions[key] = value as never;
    }
  }
  return emitOptions;
}

function getGeneratedTypes(config: PackageConfig): string[] {
  const typeNames = new Set<string>();
  const dependencies = {
    ...config.packageJson?.dependencies,
    ...config.packageJson?.devDependencies,
  };

  // React Native gets its ambient types from @tsconfig/react-native (react-native, jest).
  if (!config.depending.reactNative) {
    typeNames.add('bun');
  }
  if (
    dependencies.jest ||
    dependencies['@jest/globals'] ||
    dependencies['jest-environment-jsdom'] ||
    dependencies['ts-jest']
  ) {
    typeNames.add('jest');
  }
  if (dependencies.vitest) {
    typeNames.add('vitest/globals');
  }
  if (dependencies.mocha) {
    typeNames.add('mocha');
  }
  if (dependencies.cypress) {
    typeNames.add('cypress');
  }

  return [...typeNames];
}
