import fs from 'node:fs';
import path from 'node:path';

import { memoizeOne } from 'at-decorators';
import type { PackageJson } from 'type-fest';

import type { ScriptArgv } from './scripts/builder.js';

export class Project {
  private _dirPath: string;
  private _pathByName = new Map<string, string>();

  constructor(dirPath: string) {
    this._dirPath = dirPath;
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
