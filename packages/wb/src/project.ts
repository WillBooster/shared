import fs from 'node:fs';
import path from 'node:path';

import type { EnvReaderOptions } from '@willbooster/shared-lib-node/src';
import { readEnvironmentVariables } from '@willbooster/shared-lib-node/src';
import type { PackageJson } from 'type-fest';

import type { ScriptArgv } from './scripts/builder.js';

export class Project {
  private readonly argv: EnvReaderOptions;
  private readonly loadEnv: boolean;
  private _dirPath: string;
  private _pathByName = new Map<string, string>();

  constructor(dirPath: string, argv: EnvReaderOptions, loadEnv: boolean) {
    this._dirPath = path.resolve(dirPath);
    this.argv = argv;
    this.loadEnv = loadEnv;
  }

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

  get rootDirPath(): string {
    return fs.existsSync(path.join(this.dirPath, '..', '..', 'package.json'))
      ? path.resolve(this.dirPath, '..', '..')
      : this.dirPath;
  }

  get dockerfile(): string {
    return fs.readFileSync(this.findFile('Dockerfile'), 'utf8');
  }

  get hasDockerfile(): boolean {
    try {
      return !!this.findFile('Dockerfile');
    } catch {
      return false;
    }
  }

  get name(): string {
    return this.packageJson.name || 'unknown';
  }

  get dockerImageName(): string {
    const name = this.packageJson.name || 'unknown';
    return name.replaceAll('@', '').replaceAll('/', '-');
  }

  get env(): Record<string, string | undefined> {
    return this.loadEnv ? { ...readEnvironmentVariables(this.argv, this.dirPath), ...process.env } : process.env;
  }

  get packageJson(): PackageJson {
    return JSON.parse(fs.readFileSync(path.join(this.dirPath, 'package.json'), 'utf8'));
  }

  get rootPackageJson(): PackageJson {
    return this.rootDirPath === this.dirPath
      ? this.packageJson
      : JSON.parse(fs.readFileSync(path.join(this.rootDirPath, 'package.json'), 'utf8'));
  }

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
  const packagesDirPath = path.join(rootProject.dirPath, 'packages');
  if (!fs.existsSync(packagesDirPath)) return allProjects;

  const packageDirs = await fs.promises.readdir(packagesDirPath, { withFileTypes: true });
  for (const subPackageDir of packageDirs) {
    if (!subPackageDir.isDirectory()) continue;

    const subPackageDirPath = path.join(packagesDirPath, subPackageDir.name);
    if (!fs.existsSync(path.join(subPackageDirPath, 'package.json'))) continue;

    allProjects.push(new Project(subPackageDirPath, argv, loadEnv));
  }
  return allProjects;
}
