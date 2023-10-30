import fs from 'node:fs';
import path from 'node:path';

import type { EnvReaderOptions } from '@willbooster/shared-lib-node/src';
import { readEnvironmentVariables } from '@willbooster/shared-lib-node/src';
import type { PackageJson } from 'type-fest';

import type { ScriptArgv } from './scripts/builder.js';

/**
 * A memoization decorator/function that caches the results of the latest method/getter/function call to improve performance.
 * This decorator/function can be applied to methods and getters in a class as a decorator, and functions without context as a function.
 * The cache only stores the latest value. When a new value is computed, the previous cached value is replaced.
 *
 * @template This The type of the `this` context within the method, getter or function.
 * @template Args The types of the arguments to the method, getter or function.
 * @template Return The return type of the method, getter or function.
 *
 * @param {Function | keyof This} target The method, function or the name of getter to be memoized.
 * @param {ClassMethodDecoratorContext | ClassGetterDecoratorContext} [context] The context in which the decorator is being applied. Optional for standard functions.
 *
 * @returns {Function} A new function that wraps the original method or getter, function with caching logic.
 */
export function memoizeOne<This, Args extends unknown[], Return>(
  target: ((this: This, ...args: Args) => Return) | ((...args: Args) => Return) | keyof This,
  context?:
    | ClassMethodDecoratorContext<This, (this: This, ...args: Args) => Return>
    | ClassGetterDecoratorContext<This, Return>
): (this: This, ...args: Args) => Return {
  let lastCache: Return;

  if (context?.kind === 'getter') {
    let cached = false;
    return function (this: This): Return {
      console.log(`Entering getter ${String(context.name)}.`);

      if (!cached) {
        cached = true;
        lastCache = (target as (this: This) => Return).call(this);
      }

      console.log(`Exiting getter ${String(context.name)}.`);
      return lastCache;
    };
  }

  let lastCacheKey: string;

  return function (this: This, ...args: Args): Return {
    console.log(`Entering ${context ? `method ${String(context.name)}` : 'function'}(${JSON.stringify(args)}).`);

    const key = JSON.stringify(args);
    if (lastCacheKey !== key) {
      lastCacheKey = key;
      lastCache = context
        ? (target as (this: This, ...args: Args) => Return).call(this, ...args)
        : (target as (...args: Args) => Return)(...args);
    }

    console.log(`Exiting ${context ? `method ${String(context.name)}` : 'function'}.`);
    return lastCache;
  };
}

export class Project {
  private _dirPath: string;
  private _pathByName = new Map<string, string>();
  private _argv: EnvReaderOptions;

  constructor(dirPath: string, argv: EnvReaderOptions) {
    this._dirPath = path.resolve(dirPath);
    this._argv = argv;
  }

  @memoizeOne
  getBuildCommand(argv?: ScriptArgv): string {
    return this.packageJson.scripts?.build?.includes('buildIfNeeded')
      ? 'yarn build'
      : `YARN wb buildIfNeeded ${argv?.verbose ? '--verbose' : ''}`;
  }

  get dirPath(): string {
    return this._dirPath;
  }

  set dirPath(newDirPath: string) {
    this._dirPath = path.resolve(newDirPath);
  }

  @memoizeOne
  get rootDirPath(): string {
    return fs.existsSync(path.join(this.dirPath, '..', '..', 'package.json'))
      ? path.resolve(this.dirPath, '..', '..')
      : this.dirPath;
  }

  @memoizeOne
  get dockerfile(): string {
    return fs.readFileSync(this.findFile('Dockerfile'), 'utf8');
  }

  @memoizeOne
  get hasDockerfile(): boolean {
    try {
      return !!this.findFile('Dockerfile');
    } catch {
      return false;
    }
  }

  @memoizeOne
  get name(): string {
    return this.rootPackageJson.name || 'unknown';
  }

  @memoizeOne
  get nameWithoutNamespace(): string {
    const name = this.rootPackageJson.name || 'unknown';
    const index = name.lastIndexOf('/');
    return index === -1 ? name : name.slice(index + 1);
  }

  @memoizeOne
  get env(): Record<string, string | undefined> {
    return readEnvironmentVariables(this._argv, this.dirPath);
  }

  @memoizeOne
  get packageJson(): PackageJson {
    return JSON.parse(fs.readFileSync(path.join(this.dirPath, 'package.json'), 'utf8'));
  }

  @memoizeOne
  get rootPackageJson(): PackageJson {
    return this.rootDirPath === this.dirPath
      ? this.packageJson
      : JSON.parse(fs.readFileSync(path.join(this.rootDirPath, 'package.json'), 'utf8'));
  }

  @memoizeOne
  get dockerPackageJson(): PackageJson {
    return path.dirname(this.findFile('Dockerfile')) === this.dirPath
      ? this.packageJson
      : JSON.parse(fs.readFileSync(path.join(path.dirname(this.findFile('Dockerfile')), 'package.json'), 'utf8'));
  }

  findFile(fileName: string): string {
    let filePath = this._pathByName.get(fileName);
    if (filePath) return filePath;

    filePath = [fileName, path.join('..', '..', fileName)].find((p) => fs.existsSync(p));
    if (!filePath) {
      throw new Error(`File not found: ${fileName}`);
    }
    this._pathByName.set(fileName, filePath);
    return filePath;
  }
}

export interface FoundProjects {
  root: Project;
  self: Project;
  all: Project[];
}

export function findSelfProject(argv: EnvReaderOptions): Project | undefined {
  const dirPath = process.cwd();
  if (!fs.existsSync(path.join(dirPath, 'package.json'))) return;

  return new Project(dirPath, argv);
}

export async function findAllProjects(argv: EnvReaderOptions, dirPath?: string): Promise<FoundProjects | undefined> {
  const rootAndSelfProjects = findRootAndSelfProjects(argv, dirPath);
  if (!rootAndSelfProjects) return;

  return {
    ...rootAndSelfProjects,
    all:
      rootAndSelfProjects.root === rootAndSelfProjects.self
        ? await getAllProjects(argv, rootAndSelfProjects.root)
        : [rootAndSelfProjects.self],
  };
}

export function findRootAndSelfProjects(
  argv: EnvReaderOptions,
  dirPath?: string
): Omit<FoundProjects, 'all'> | undefined {
  // Tests pass dirPath
  dirPath ??= process.cwd();
  if (!fs.existsSync(path.join(dirPath, 'package.json'))) return;

  const thisProject = new Project(dirPath, argv);
  let rootProject = thisProject;
  if (!thisProject.packageJson.workspaces && path.dirname(dirPath).endsWith('/packages')) {
    const rootDirPath = path.resolve(dirPath, '..', '..');
    if (fs.existsSync(path.join(rootDirPath, 'package.json'))) {
      rootProject = new Project(rootDirPath, argv);
    }
  }
  return { root: rootProject, self: thisProject };
}

async function getAllProjects(argv: EnvReaderOptions, rootProject: Project): Promise<Project[]> {
  const allProjects = [rootProject];
  const packageDirPath = path.join(rootProject.dirPath, 'packages');
  if (!fs.existsSync(packageDirPath)) return [];

  const packageDirs = await fs.promises.readdir(packageDirPath, { withFileTypes: true });
  for (const packageDir of packageDirs) {
    if (!packageDir.isDirectory()) continue;

    const packageJsonPath = path.join(packageDirPath, 'package.json');
    if (!fs.existsSync(packageJsonPath)) continue;

    allProjects.push(new Project(packageJsonPath, argv));
  }
  return allProjects;
}
