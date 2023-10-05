import fs from 'node:fs';
import path from 'node:path';

import type { PackageJson } from 'type-fest';

import type { ScriptArgv } from './scripts/builder.js';

class Project {
  private _buildCommand: string | undefined;
  private _dirPath: string;
  private _rootDirPath: string | undefined;
  private _dockerfile: string | undefined;
  private _hasDockerfile: boolean | undefined;
  private _name: string | undefined;
  private _nameWithoutNamespace: string | undefined;
  private _rootPackageJson: PackageJson | undefined;
  private _dockerPackageJson: PackageJson | undefined;
  private _packageJson: PackageJson | undefined;
  private _pathByName = new Map<string, string>();

  constructor() {
    this._dirPath = process.cwd();
  }

  getBuildCommand(argv?: ScriptArgv): string {
    return (this._buildCommand ??= this.packageJson.scripts?.build?.includes('buildIfNeeded')
      ? 'yarn build'
      : `YARN wb buildIfNeeded ${argv?.verbose ? '--verbose' : ''}`);
  }

  get dirPath(): string {
    return this._dirPath;
  }

  set dirPath(newDirPath: string) {
    this._dirPath = path.resolve(newDirPath);
  }

  get rootDirPath(): string {
    return (this._rootDirPath ??= fs.existsSync(path.join(this.dirPath, '..', '..', 'package.json'))
      ? path.resolve(this.dirPath, '..', '..')
      : this.dirPath);
  }

  get dockerfile(): string {
    return (this._dockerfile ??= fs.readFileSync(this.findFile('Dockerfile'), 'utf8'));
  }

  get hasDockerfile(): boolean {
    if (this._hasDockerfile !== undefined) return this._hasDockerfile;

    try {
      this._hasDockerfile = !!this.findFile('Dockerfile');
    } catch {
      this._hasDockerfile = false;
    }
    return this._hasDockerfile;
  }

  get name(): string {
    return (this._name ??= project.rootPackageJson.name || 'unknown');
  }

  get nameWithoutNamespace(): string {
    if (this._nameWithoutNamespace === undefined) {
      const name = project.rootPackageJson.name || 'unknown';
      const index = name.lastIndexOf('/');
      this._nameWithoutNamespace = index === -1 ? name : name.slice(index + 1);
    }
    return this._nameWithoutNamespace;
  }

  get packageJson(): PackageJson {
    return (this._packageJson ??= JSON.parse(fs.readFileSync(path.join(this.dirPath, 'package.json'), 'utf8')));
  }

  get rootPackageJson(): PackageJson {
    return (this._rootPackageJson ??=
      this.rootDirPath === this.dirPath
        ? this.packageJson
        : JSON.parse(fs.readFileSync(path.join(this.rootDirPath, 'package.json'), 'utf8')));
  }

  get dockerPackageJson(): PackageJson {
    return (this._dockerPackageJson ??=
      path.dirname(this.findFile('Dockerfile')) === this.dirPath
        ? this.packageJson
        : JSON.parse(fs.readFileSync(path.join(path.dirname(this.findFile('Dockerfile')), 'package.json'), 'utf8')));
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

export const project = new Project();
