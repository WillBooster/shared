import fs from 'node:fs';
import path from 'node:path';

import type { PackageJson } from 'type-fest';

class Project {
  private _dirPath: string;
  private _dockerfile: string | undefined;
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
    return (this._dockerfile ??= fs.readFileSync(path.join(this.dirPath, 'Dockerfile'), 'utf8'));
  }

  get hasDockerfile(): boolean {
    return (this._hasDockerfile ??= fs.existsSync(path.join(this.dirPath, 'Dockerfile')));
  }

  get name(): string {
    return (this._name ??= project.packageJson.name || 'unknown');
  }

  get packageJson(): PackageJson {
    return (this._packageJson ??= JSON.parse(fs.readFileSync(path.join(this.dirPath, 'package.json'), 'utf8')));
  }
}

export const project = new Project();
