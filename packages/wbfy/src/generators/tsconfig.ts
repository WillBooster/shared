import fs from 'node:fs';
import path from 'node:path';

import merge from 'deepmerge';
import type { ParseError } from 'jsonc-parser';
import { parse as parseJsonc } from 'jsonc-parser';
import type { TsConfigJson } from 'type-fest';

import { logger } from '../logger.js';
import type { PackageConfig } from '../packageConfig.js';
import { fsUtil } from '../utils/fsUtil.js';
import { combineMerge } from '../utils/mergeUtil.js';
import { sortKeys } from '../utils/objectUtil.js';
import { promisePool } from '../utils/promisePool.js';
import { getTsconfigExtends } from '../utils/tsconfigBase.js';

const rootJsonObj = {
  compilerOptions: {
    alwaysStrict: true,
    noUncheckedIndexedAccess: true, // for @typescript-eslint/prefer-nullish-coalescing
    allowSyntheticDefaultImports: true, // allow `import React from 'react'`
    esModuleInterop: true, // allow default import from CommonJS/AMD/UMD modules
    resolveJsonModule: true, // allow to import JSON files
    importHelpers: false,
    noEmit: true,
  },
  exclude: ['packages/*/test/fixtures', 'test/fixtures'],
  include: [
    '*.config.ts',
    'packages/*/*.config.ts',
    'packages/*/scripts/**/*',
    'packages/*/src/**/*',
    'packages/*/test/**/*',
    'scripts/**/*',
    'src/**/*',
    'test/**/*',
  ],
};

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
  include: ['*.config.ts', 'scripts/**/*', 'src/**/*', 'test/**/*'],
};

export async function generateTsconfig(config: PackageConfig): Promise<void> {
  return logger.functionIgnoringException('generateTsconfig', async () => {
    if (config.depending.blitz || config.depending.next) {
      await cleanupLegacyTsconfigModuleSettings(config);
      return;
    }

    let newSettings = structuredClone(config.isRoot ? rootJsonObj : subJsonObj) as TsConfigJson;
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
    if (config.isRoot && !config.doesContainSubPackageJsons) {
      newSettings.include = newSettings.include?.filter((dirPath: string) => !dirPath.startsWith('packages/*/'));
      newSettings.exclude = newSettings.exclude?.filter((dirPath: string) => !dirPath.startsWith('packages/*/'));
    }
    if (config.depending.prisma) {
      // Prisma seeds and migration helper scripts often live outside src, but
      // type-aware linting still needs them covered by the project config.
      addIncludePath(newSettings, 'prisma/**/*');
    }

    const filePath = path.resolve(config.dirPath, 'tsconfig.json');
    const existingContent = await fs.promises.readFile(filePath, 'utf8').catch(() => {});
    if (existingContent !== undefined) {
      const oldSettings = parseTsconfigJsonc(existingContent);
      // An existing tsconfig.json wbfy cannot parse must be left untouched: writing the
      // generated settings without merging would silently discard the project's configuration.
      if (!oldSettings) return;
      const existingTypes = normalizeStringArray(oldSettings.compilerOptions?.types);
      const existingEmitMetadata = pickExistingEmitMetadata(oldSettings.compilerOptions);
      newSettings.extends = mergeTsconfigExtends(newSettings.extends, oldSettings.extends);
      delete oldSettings.extends;
      delete oldSettings.compilerOptions?.jsx;
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
      ensureTsExtensionEmitCompatibility(newSettings.compilerOptions);

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
    const newContent = JSON.stringify(newSettings, undefined, 2);
    await promisePool.run(() => fsUtil.generateFile(filePath, newContent));
  });
}

async function cleanupLegacyTsconfigModuleSettings(config: PackageConfig): Promise<void> {
  // Next/Blitz own their tsconfig shape, but TypeScript 6 no longer accepts
  // node10 resolver spellings that older projects commonly inherited.
  const filePath = path.resolve(config.dirPath, 'tsconfig.json');
  const existingContent = await fs.promises.readFile(filePath, 'utf8').catch(() => {});
  if (existingContent === undefined) return;
  const settings = parseTsconfigJsonc(existingContent);
  if (!settings) return;
  normalizeNextTsconfigModuleSettings(settings);
  normalizeNextTsconfigPathAliases(settings.compilerOptions);
  addScriptsIncludeForFrameworkProject(settings);
  addUndiciTypesPathMapping(settings, config);
  await promisePool.run(() => fsUtil.generateFile(filePath, JSON.stringify(settings, undefined, 2)));
}

/**
 * tsconfig.json allows JSONC, so read it with jsonc-parser instead of JSON.parse. jsonc-parser is
 * fault tolerant and returns a partial object for malformed input, which must not be merged as if
 * it were the project's configuration; reject any parse error.
 */
function parseTsconfigJsonc(content: string): TsConfigJson | undefined {
  const parseErrors: ParseError[] = [];
  const settings = parseJsonc(content, parseErrors, { allowTrailingComma: true }) as TsConfigJson | undefined;
  return parseErrors.length === 0 && settings && typeof settings === 'object' ? settings : undefined;
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
  // Keep a repo-local mapping (e.g. patched types) when the project already declares one.
  if (settings.compilerOptions?.paths?.['undici-types']) return;

  settings.compilerOptions ??= {};
  settings.compilerOptions.paths = {
    ...settings.compilerOptions.paths,
    'undici-types': [`${getRootDir(config)}/node_modules/undici-types/index.d.ts`],
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
  return fs.existsSync(path.resolve(config.dirPath, '..', '..', 'package.json')) ? '../..' : '.';
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

function ensureTsExtensionEmitCompatibility(compilerOptions: TsConfigJson.CompilerOptions | undefined): void {
  if (!compilerOptions) return;
  if (compilerOptions.noEmit !== false || compilerOptions.emitDeclarationOnly === true) return;

  // @tsconfig/bun enables allowImportingTsExtensions, which TypeScript permits
  // during emit only when relative TS extensions are rewritten.
  compilerOptions.rewriteRelativeImportExtensions = true;
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
