import fs from 'node:fs';
import path from 'node:path';

export function usesBunRuntime(dirPath: string): boolean {
  for (let currentPath = path.resolve(dirPath); ; currentPath = path.dirname(currentPath)) {
    if (
      ['bun.lock', 'bun.lockb'].some((fileName) => fs.existsSync(path.join(currentPath, fileName))) ||
      hasBunPackageManager(path.join(currentPath, 'package.json')) ||
      ['mise.toml', '.mise.toml'].some((fileName) =>
        testFileContent(path.join(currentPath, fileName), /^\s*(?:"bun"|bun)\s*=/m)
      ) ||
      testFileContent(path.join(currentPath, '.tool-versions'), /(^|\n)bun\s/)
    ) {
      return true;
    }
    if (fs.existsSync(path.join(currentPath, '.git'))) return false;
    const parentPath = path.dirname(currentPath);
    if (parentPath === currentPath) return false;
  }
}

function hasBunPackageManager(packageJsonPath: string): boolean {
  try {
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as { packageManager?: unknown };
    return typeof packageJson.packageManager === 'string' && packageJson.packageManager.startsWith('bun@');
  } catch {
    return false;
  }
}

function testFileContent(filePath: string, pattern: RegExp): boolean {
  try {
    return pattern.test(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return false;
  }
}
