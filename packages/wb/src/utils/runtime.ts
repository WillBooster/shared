import fs from 'node:fs';
import path from 'node:path';

export function usesBunRuntime(dirPath: string): boolean {
  for (let currentPath = path.resolve(dirPath); ; currentPath = path.dirname(currentPath)) {
    if (
      hasBunDirectoryMarker(currentPath) ||
      isBunPackageManager(readPackageManagerField(path.join(currentPath, 'package.json')))
    ) {
      return true;
    }
    if (fs.existsSync(path.join(currentPath, '.git'))) return false;
    const parentPath = path.dirname(currentPath);
    if (parentPath === currentPath) return false;
  }
}

/**
 * Whether the directory carries a bun marker: a bun lockfile, a mise-pinned bun, or a
 * `.tool-versions` bun entry. wbfy migrates .tool-versions into mise.toml, so a mise-pinned bun
 * must count as well: repos that gitignore bun.lock and have no packageManager field rely on the
 * tool manifest. This is the single signal list deciding bun-vs-yarn; `Project.usesBunPackageManager`
 * shares it so the two detections cannot drift.
 */
export function hasBunDirectoryMarker(dirPath: string): boolean {
  return (
    ['bun.lock', 'bun.lockb'].some((fileName) => fs.existsSync(path.join(dirPath, fileName))) ||
    ['mise.toml', '.mise.toml'].some((fileName) =>
      testFileContent(path.join(dirPath, fileName), /^\s*(?:"bun"|bun)\s*=/m)
    ) ||
    testFileContent(path.join(dirPath, '.tool-versions'), /(^|\n)bun\s/)
  );
}

export function isBunPackageManager(packageManager: unknown): boolean {
  return typeof packageManager === 'string' && packageManager.startsWith('bun@');
}

function readPackageManagerField(packageJsonPath: string): unknown {
  try {
    return (JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as { packageManager?: unknown }).packageManager;
  } catch {
    return undefined;
  }
}

function testFileContent(filePath: string, pattern: RegExp): boolean {
  try {
    return pattern.test(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return false;
  }
}
