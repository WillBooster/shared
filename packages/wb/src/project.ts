import fs from 'node:fs';
import path from 'node:path';

import type { PackageJson } from 'type-fest';

import type { ScriptArgv } from './scripts/builder.js';

class Project {
  private _buildCommand: string | undefined;
  private _dirPath: string;
  private _dockerfile: string | undefined;
  private _dockerfilePath: string | undefined;
  private _hasDockerfile: boolean | undefined;
  private _name: string | undefined;
  private _rootPackageJson: PackageJson | undefined;
  private _dockerPackageJson: PackageJson | undefined;
  private _packageJson: PackageJson | undefined;

  constructor() {
    this._dirPath = process.cwd();
  }

  getBuildCommand(argv?: ScriptArgv): string {
    return (this._buildCommand ??= this.packageJson.scripts?.build?.includes('buildIfNeeded')
      ? 'yarn build'
      : `YARN wb buildIfNeeded ${argv?.verbose ? '--verbose' : ''}}`);
  }

  get dirPath(): string {
    return this._dirPath;
  }

  set dirPath(newDirPath: string) {
    this._dirPath = path.resolve(newDirPath);
  }

  get dockerfile(): string {
    return (this._dockerfile ??= fs.readFileSync(this.dockerfilePath, 'utf8'));
  }

  get dockerfilePath(): string {
    if (this._dockerfilePath) return this._dockerfilePath;

    if (fs.existsSync(path.join(this.dirPath, 'Dockerfile'))) {
      this._dockerfilePath = path.join(this.dirPath, 'Dockerfile');
    } else if (fs.existsSync(path.join(this.dirPath, '..', '..', 'Dockerfile'))) {
      this._dockerfilePath = path.join(this.dirPath, '..', '..', 'Dockerfile');
    } else {
      throw new Error('Dockerfile not found');
    }
    return this._dockerfilePath;
  }

  get hasDockerfile(): boolean {
    if (this._hasDockerfile !== undefined) return this._hasDockerfile;

    try {
      this._hasDockerfile = !!this.dockerfilePath;
    } catch {
      this._hasDockerfile = false;
    }
    return this._hasDockerfile;
  }

  get name(): string {
    return (this._name ??= project.rootPackageJson.name || 'unknown');
  }

  get packageJson(): PackageJson {
    return (this._packageJson ??= JSON.parse(fs.readFileSync(path.join(this.dirPath, 'package.json'), 'utf8')));
  }

  get rootPackageJson(): PackageJson {
    return (this._rootPackageJson ??= fs.existsSync(path.join(this.dirPath, '..', '..', 'package.json'))
      ? JSON.parse(fs.readFileSync(path.join(this.dirPath, '..', '..', 'package.json'), 'utf8'))
      : this.packageJson);
  }

  get dockerPackageJson(): PackageJson {
    return (this._dockerPackageJson ??=
      path.dirname(this.dockerfilePath) === this.dirPath
        ? this.packageJson
        : JSON.parse(fs.readFileSync(path.join(path.dirname(this.dockerfilePath), 'package.json'), 'utf8')));
  }
}

export const project = new Project();
