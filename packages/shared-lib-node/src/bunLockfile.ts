import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Anchored to `", ` so only a registry entry's `resolved` slot is cleared. A direct tarball
 * dependency carries its URL in the workspace descriptor and tuple identifier instead, and those
 * URLs must remain intact.
 */
const guardResolvedUrlPattern = /(", )"https:\/\/npm\.flatt\.tech\/[^"]*"/g;

/**
 * Remove Takumi Guard proxy URLs from the nearest enclosing bun.lock.
 *
 * Bun writes the workspace root's lockfile even when an install runs from a child package, so the
 * search climbs only as far as the repository root. The proxy is install-time policy rather than
 * repository state: an empty resolved slot still makes Bun use the configured default registry.
 */
export function normalizeBunLockfile(startDirPath: string): boolean {
  const lockfilePath = findBunLockfilePath(startDirPath);
  if (!lockfilePath) return false;

  const content = fs.readFileSync(lockfilePath, 'utf8');
  const normalizedContent = content.replaceAll(guardResolvedUrlPattern, '$1""');
  if (normalizedContent === content) return false;

  const temporaryPath = `${lockfilePath}.normalizing.${process.pid}.${crypto.randomUUID()}`;
  try {
    const mode = fs.statSync(lockfilePath).mode & 0o777;
    fs.writeFileSync(temporaryPath, normalizedContent, { mode });
    fs.chmodSync(temporaryPath, mode);
    fs.renameSync(temporaryPath, lockfilePath);
  } finally {
    fs.rmSync(temporaryPath, { force: true });
  }
  return true;
}

function findBunLockfilePath(startDirPath: string): string | undefined {
  let dirPath = path.resolve(startDirPath);
  while (true) {
    const lockfilePath = path.join(dirPath, 'bun.lock');
    if (fs.existsSync(lockfilePath)) return lockfilePath;
    if (fs.existsSync(path.join(dirPath, '.git'))) return;

    const parentDirPath = path.dirname(dirPath);
    if (parentDirPath === dirPath) return;
    dirPath = parentDirPath;
  }
}
