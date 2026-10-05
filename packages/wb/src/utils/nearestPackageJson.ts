import fs from 'node:fs';
import path from 'node:path';

/** Reads the `package.json` of the package that contains `filePath`. */
export function readNearestPackageJson(filePath: string): { dirPath: string; packageJson: unknown } {
  let dirPath = path.dirname(filePath);
  while (!fs.existsSync(path.join(dirPath, 'package.json'))) {
    dirPath = path.dirname(dirPath);
  }
  return { dirPath, packageJson: JSON.parse(fs.readFileSync(path.join(dirPath, 'package.json'), 'utf8')) };
}
