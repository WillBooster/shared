import fs from 'node:fs';
import path from 'node:path';

import { memoizeOne } from 'at-decorators';
import type { PackageJson } from 'type-fest';

import type { ScriptArgv } from './scripts/builder.js';

export class Project {
  private _dirPath: string;
  private _pathByName = new Map<string, string>();

  constructor(dirPath: string) {
    this._dirPath = path.resolve(dirPath);
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

export function findRootAndSelfProjects(): Omit<FoundProjects, 'all'> | undefined {
  const dirPath = process.cwd();
  if (!fs.existsSync(path.join(dirPath, 'package.json'))) return;

  const thisProject = new Project(dirPath);
  let rootProject = thisProject;
  if (!thisProject.packageJson.workspaces && path.dirname(dirPath) === 'packages') {
    const rootDirPath = path.resolve(dirPath, '..', '..');
    if (fs.existsSync(path.join(rootDirPath, 'package.json'))) {
      rootProject = new Project(rootDirPath);
    }
  }
  return { root: rootProject, self: thisProject };
}

export async function findAllProjects(): Promise<FoundProjects | undefined> {
  const rootAndSelfProjects = findRootAndSelfProjects();
  if (!rootAndSelfProjects) return;

  return { ...rootAndSelfProjects, all: await getAllProjects(rootAndSelfProjects.root) };
}

async function getAllProjects(rootProject: Project): Promise<Project[]> {
  const allProjects = [rootProject];
  const packageDirPath = path.join(rootProject.dirPath, 'packages');
  const packageDirs = await fs.promises.readdir(packageDirPath, { withFileTypes: true });
  for (const packageDir of packageDirs) {
    if (!packageDir.isDirectory()) continue;

    const packageJsonPath = path.join(packageDirPath, 'package.json');
    if (!fs.existsSync(packageJsonPath)) continue;

    allProjects.push(new Project(packageJsonPath));
  }
  return allProjects;
}
