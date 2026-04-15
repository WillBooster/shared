import fs from 'node:fs';
import path from 'node:path';

import merge from 'deepmerge';
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
  include: ['scripts/**/*', 'src/**/*', 'test/**/*'],
};

export async function generateTsconfig(config: PackageConfig): Promise<void> {
  return logger.functionIgnoringException('generateTsconfig', async () => {
    if (config.depending.blitz || config.depending.next) return;

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
    } else if (!config.isBun && !config.depending.reactNative) {
      newSettings.compilerOptions = { ...newSettings.compilerOptions, jsx: 'react-jsx' };
    }
    if (config.isRoot && !config.doesContainSubPackageJsons) {
      newSettings.include = newSettings.include?.filter((dirPath: string) => !dirPath.startsWith('packages/*/'));
      newSettings.exclude = newSettings.exclude?.filter((dirPath: string) => !dirPath.startsWith('packages/*/'));
    }

    const filePath = path.resolve(config.dirPath, 'tsconfig.json');
    try {
      const existingContent = await fs.promises.readFile(filePath, 'utf8');
      const oldSettings = JSON.parse(existingContent) as TsConfigJson;
      const existingTypes = normalizeStringArray(oldSettings.compilerOptions?.types);
      const existingEmitOptions = pickExistingEmitOptions(oldSettings.compilerOptions);
      newSettings.extends = mergeTsconfigExtends(newSettings.extends, oldSettings.extends);
      delete oldSettings.extends;
      delete oldSettings.compilerOptions?.jsx;
      newSettings = merge.all([newSettings, oldSettings, newSettings], { arrayMerge: combineMerge });
      newSettings.include = newSettings.include?.filter(
        (dirPath: string) =>
          !dirPath.includes('@types') && !dirPath.includes('__tests__/') && !dirPath.includes('tests/')
      );
      newSettings.compilerOptions ??= {};
      // Keep explicit emit settings because some repos have tsconfig.build.json files
      // that extend this config and rely on those options for tracked .d.ts outputs.
      newSettings.compilerOptions = { ...newSettings.compilerOptions, ...existingEmitOptions };
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
    } catch {
      // do nothing
    }
    sortKeys(newSettings);
    newSettings.include?.sort();
    // Don't use old decorator
    delete newSettings.compilerOptions?.experimentalDecorators;
    if (config.depending.reactNative) {
      delete newSettings.compilerOptions?.verbatimModuleSyntax;
    }
    const newContent = JSON.stringify(newSettings, undefined, 2);
    await promisePool.run(() => fsUtil.generateFile(filePath, newContent));
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

function pickExistingEmitOptions(
  compilerOptions: TsConfigJson['compilerOptions']
): Pick<
  NonNullable<TsConfigJson['compilerOptions']>,
  'declaration' | 'declarationMap' | 'emitDeclarationOnly' | 'noEmit' | 'sourceMap'
> {
  const emitOptions = {} as Pick<
    NonNullable<TsConfigJson['compilerOptions']>,
    'declaration' | 'declarationMap' | 'emitDeclarationOnly' | 'noEmit' | 'sourceMap'
  >;
  for (const key of ['declaration', 'declarationMap', 'emitDeclarationOnly', 'noEmit', 'sourceMap'] as const) {
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

  if (config.isBun) {
    typeNames.add('bun');
  } else if (!config.depending.reactNative) {
    typeNames.add('node');
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
