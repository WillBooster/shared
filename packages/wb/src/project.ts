import fs from 'node:fs';
import path from 'node:path';

import type { EnvReaderOptions } from '@willbooster/shared-lib-node/src';
import { readEnvironmentVariables } from '@willbooster/shared-lib-node/src';
import { memoizeFactory } from 'at-decorators';
import { globby } from 'globby';
import type { PackageJson } from 'type-fest';

const memoize = memoizeFactory(Number.MAX_SAFE_INTEGER, 1);

export class Project {
  private readonly argv: EnvReaderOptions;
  private readonly loadEnv: boolean;
  private readonly pathByName = new Map<string, string>();

  private readonly _dirPath: string;

  constructor(dirPath: string, argv: EnvReaderOptions, loadEnv: boolean) {
    this._dirPath = path.resolve(dirPath);
    this.argv = argv;
    this.loadEnv = loadEnv;
  }

  @memoize
  get buildCommand(): string {
    return this.packageJson.scripts?.build?.includes('buildIfNeeded')
      ? 'yarn build'
      : `YARN wb buildIfNeeded ${this.argv.verbose ? '--verbose' : ''}`;
  }

  get dirPath(): string {
    return this._dirPath;
  }

  @memoize
  get rootDirPath(): string {
    return fs.existsSync(path.join(this.dirPath, '..', '..', 'package.json'))
      ? path.resolve(this.dirPath, '..', '..')
      : this.dirPath;
  }

  @memoize
  get dockerfile(): string {
    return fs.readFileSync(this.findFile('Dockerfile'), 'utf8');
  }

  @memoize
  get hasDockerfile(): boolean {
    try {
      return !!this.findFile('Dockerfile');
    } catch {
      return false;
    }
  }

  @memoize
  get name(): string {
    return this.packageJson.name || 'unknown';
  }

  @memoize
  get dockerImageName(): string {
    const name = this.packageJson.name || 'unknown';
    return name.replaceAll('@', '').replaceAll('/', '-');
  }

  @memoize
  get env(): Record<string, string | undefined> {
    return this.loadEnv ? { ...readEnvironmentVariables(this.argv, this.dirPath), ...process.env } : process.env;
  }

  @memoize
  get packageJson(): PackageJson {
    return JSON.parse(fs.readFileSync(path.join(this.dirPath, 'package.json'), 'utf8'));
  }

  @memoize
  get hasPrisma(): boolean {
    return !!(this.packageJson.dependencies?.['prisma'] || this.packageJson.devDependencies?.['prisma']);
  }

  @memoize
  get dockerPackageJson(): PackageJson {
    return path.dirname(this.findFile('Dockerfile')) === this.dirPath
      ? this.packageJson
      : JSON.parse(fs.readFileSync(path.join(path.dirname(this.findFile('Dockerfile')), 'package.json'), 'utf8'));
  }

  @memoize
  get binExists(): boolean {
    let binFound = false;
    let currentPath = this.dirPath;
    for (;;) {
      const binPath = path.join(currentPath, 'node_modules', '.bin');
      if (fs.existsSync(binPath)) {
        this.env.PATH = `${binPath}:${this.env.PATH}`;
        binFound = true;
      }

      if (fs.existsSync(path.join(currentPath, '.git'))) {
        break;
      }
      const parentPath = path.dirname(currentPath);
      if (currentPath === parentPath) {
        break;
      }
      currentPath = parentPath;
    }
    return binFound;
  }

  findFile(fileName: string): string {
    let filePath = this.pathByName.get(fileName);
    if (filePath) return filePath;

    filePath = [fileName, path.join('..', '..', fileName)]
      .map((p) => path.resolve(this.dirPath, p))
      .find((p) => fs.existsSync(p));
    if (!filePath) {
      throw new Error(`File not found: ${fileName}`);
    }
    this.pathByName.set(fileName, filePath);
    return filePath;
  }
}

export interface FoundProjects {
  root: Project;
  self: Project;
  all: Project[];
}

export function findSelfProject(argv: EnvReaderOptions, loadEnv = true, dirPath?: string): Project | undefined {
  dirPath ??= process.cwd();
  if (!fs.existsSync(path.join(dirPath, 'package.json'))) return;

  return new Project(dirPath, argv, loadEnv);
}

export async function findAllProjects(
  argv: EnvReaderOptions,
  loadEnv = true,
  dirPath?: string
): Promise<FoundProjects | undefined> {
  const rootAndSelfProjects = findRootAndSelfProjects(argv, loadEnv, dirPath);
  if (!rootAndSelfProjects) return;

  return {
    ...rootAndSelfProjects,
    all:
      rootAndSelfProjects.root === rootAndSelfProjects.self
        ? await getAllProjects(argv, rootAndSelfProjects.root, loadEnv)
        : [rootAndSelfProjects.self],
  };
}

export function findRootAndSelfProjects(
  argv: EnvReaderOptions,
  loadEnv = true,
  dirPath?: string
): Omit<FoundProjects, 'all'> | undefined {
  dirPath ??= process.cwd();
  if (!fs.existsSync(path.join(dirPath, 'package.json'))) return;

  const thisProject = new Project(dirPath, argv, loadEnv);
  let rootProject = thisProject;
  if (!thisProject.packageJson.workspaces && path.dirname(dirPath).endsWith('/packages')) {
    const rootDirPath = path.resolve(dirPath, '..', '..');
    if (fs.existsSync(path.join(rootDirPath, 'package.json'))) {
      rootProject = new Project(rootDirPath, argv, loadEnv);
    }
  }
  return { root: rootProject, self: thisProject };
}

async function getAllProjects(argv: EnvReaderOptions, rootProject: Project, loadEnv: boolean): Promise<Project[]> {
  const allProjects = [rootProject];

  const workspace = rootProject.packageJson.workspaces;
  if (!Array.isArray(workspace)) return allProjects;

  const globPattern: string[] = [];
  const packageDirs: string[] = [];
  for (const workspacePath of workspace.map((ws: string) => path.join(rootProject.dirPath, ws))) {
    if (fs.existsSync(workspacePath)) {
      packageDirs.push(workspacePath);
    } else {
      globPattern.push(workspacePath);
    }
  }
  packageDirs.push(...(await globby(globPattern, { dot: true, onlyDirectories: true })));
  for (const subPackageDirPath of packageDirs) {
    if (!fs.existsSync(path.join(subPackageDirPath, 'package.json'))) continue;

    allProjects.push(new Project(subPackageDirPath, argv, loadEnv));
  }
  return allProjects;
}
