import fs from 'node:fs';
import path from 'node:path';

import type { PackageJson } from 'type-fest';

class Project {
  private _dirPath: string;
  private _dockerfile: string | undefined;
  private _dockerfilePath: string | undefined;
  private _hasDockerfile: boolean | undefined;
  private _name: string | undefined;
  private _packageJson: PackageJson | undefined;

  constructor() {
    this._dirPath = process.cwd();
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

  get rootPackageJson(): PackageJson {
    return (this._packageJson ??= fs.existsSync(path.join(this.dirPath, '..', '..', 'package.json'))
      ? JSON.parse(fs.readFileSync(path.join(this.dirPath, '..', '..', 'package.json'), 'utf8'))
      : this.packageJson);
  }

  get packageJson(): PackageJson {
    return (this._packageJson ??= JSON.parse(fs.readFileSync(path.join(this.dirPath, 'package.json'), 'utf8')));
  }
}

export const project = new Project();
