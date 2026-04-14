import fs from 'node:fs';
import path from 'node:path';

import merge from 'deepmerge';
import cloneDeep from 'lodash.clonedeep';
import type { TsConfigJson } from 'type-fest';

import { logger } from '../logger.js';
import type { PackageConfig } from '../packageConfig.js';
import { fsUtil } from '../utils/fsUtil.js';
import { combineMerge } from '../utils/mergeUtil.js';
import { sortKeys } from '../utils/objectUtil.js';
import { promisePool } from '../utils/promisePool.js';
import { getSrcDirs } from '../utils/srcDirectories.js';
import { getTsconfigExtends } from '../utils/tsconfigBase.js';

const rootJsonObj = {
  compilerOptions: {
    alwaysStrict: true,
    noUncheckedIndexedAccess: true, // for @typescript-eslint/prefer-nullish-coalescing
    allowSyntheticDefaultImports: true, // allow `import React from 'react'`
    esModuleInterop: true, // allow default import from CommonJS/AMD/UMD modules
    resolveJsonModule: true, // allow to import JSON files
    declaration: true,
    sourceMap: true,
    importHelpers: false,
    noEmit: false,
    outDir: 'dist',
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
    declaration: true,
    sourceMap: true,
    importHelpers: false,
    noEmit: false,
    outDir: 'dist',
  },
  exclude: ['test/fixtures'],
  include: ['scripts/**/*', 'src/**/*', 'test/**/*'],
};

export async function generateTsconfig(config: PackageConfig): Promise<void> {
  return logger.functionIgnoringException('generateTsconfig', async () => {
    if (config.depending.blitz || config.depending.next) return;

    let newSettings = cloneDeep(config.isRoot ? rootJsonObj : subJsonObj) as TsConfigJson;
    const generatedRootDir = getGeneratedRootDir(config);
    const generatedTypes = getGeneratedTypes(config);
    newSettings.extends = getTsconfigExtends(config);
    if (generatedRootDir) {
      newSettings.compilerOptions = { ...newSettings.compilerOptions, rootDir: generatedRootDir };
    }
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
      const existingRootDir = oldSettings.compilerOptions?.rootDir;
      const existingTypes = normalizeStringArray(oldSettings.compilerOptions?.types);
      newSettings.extends = mergeTsconfigExtends(newSettings.extends, oldSettings.extends);
      delete oldSettings.extends;
      delete oldSettings.compilerOptions?.jsx;
      newSettings = merge.all([newSettings, oldSettings, newSettings], { arrayMerge: combineMerge });
      newSettings.include = newSettings.include?.filter(
        (dirPath: string) =>
          !dirPath.includes('@types') && !dirPath.includes('__tests__/') && !dirPath.includes('tests/')
      );
      newSettings.compilerOptions ??= {};
      const safeGeneratedRootDir = getSafeGeneratedRootDir(config, generatedRootDir, newSettings.include);
      if (existingRootDir && !shouldReplaceExistingRootDir(existingRootDir, safeGeneratedRootDir)) {
        newSettings.compilerOptions.rootDir = existingRootDir;
      } else if (safeGeneratedRootDir) {
        newSettings.compilerOptions.rootDir = safeGeneratedRootDir;
      } else {
        delete newSettings.compilerOptions.rootDir;
      }

      const mergedTypes = [...new Set([...existingTypes, ...generatedTypes])];
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

function getGeneratedRootDir(config: PackageConfig): string | undefined {
  const rootDirCandidates = getRootDirCandidates(config);
  // Keep test and scripts in this list so mixed tsconfigs omit rootDir instead of
  // generating a src-only rootDir that conflicts with the generated include globs.
  const existingIncludedDirs = getSrcDirs(config).filter((dirName) =>
    fs.existsSync(path.resolve(config.dirPath, dirName))
  );
  const existingRootSourceDirs = existingIncludedDirs.filter((dirName) => rootDirCandidates.includes(dirName));

  // Subpackage tsconfigs inherit root options, so a monorepo rootDir would shift
  // generated package declarations into nested paths such as dist/shared/shared/src.
  if (config.isRoot && config.doesContainSubPackageJsons) return undefined;

  if (existingIncludedDirs.length === 1 && existingRootSourceDirs.length === 1) {
    return `./${existingRootSourceDirs[0]}`;
  }
}

function getRootDirCandidates(config: PackageConfig): string[] {
  return getSrcDirs(config).filter((dirName) => dirName !== 'scripts' && dirName !== 'test');
}

function shouldReplaceExistingRootDir(existingRootDir: string, generatedRootDir: string | undefined): boolean {
  // Mixed source/test tsconfigs must omit rootDir; otherwise src-only rootDir breaks typecheck,
  // while "." changes library declaration output from dist/*.d.ts to dist/src/*.d.ts.
  return generatedRootDir === undefined || (existingRootDir === '.' && generatedRootDir !== '.');
}

function getSafeGeneratedRootDir(
  config: PackageConfig,
  generatedRootDir: string | undefined,
  includes: TsConfigJson['include']
): string | undefined {
  if (!generatedRootDir || !includes) return generatedRootDir;

  const rootDirPath = path.resolve(config.dirPath, generatedRootDir);
  const hasExistingInputOutsideRootDir = includes.some((includePath) => {
    const firstPathPart = includePath.split('/')[0];
    if (!firstPathPart || firstPathPart.includes('*')) return false;

    const inputPath = path.resolve(config.dirPath, firstPathPart);
    // Keep rootDir for generated globs such as scripts/**/* and test/**/* when the
    // directories do not exist, but drop it for real root-level files like vite.config.ts.
    return fs.existsSync(inputPath) && !inputPath.startsWith(`${rootDirPath}${path.sep}`) && inputPath !== rootDirPath;
  });

  return hasExistingInputOutsideRootDir ? undefined : generatedRootDir;
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
