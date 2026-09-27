import fs from 'node:fs';
import path from 'node:path';

import { writeFileAtomicSync } from './writeFileAtomic.js';

/**
 * Anchored to `", ` so only a registry entry's `resolved` slot is cleared. A direct tarball
 * dependency carries its URL in the workspace descriptor and tuple identifier instead, and those
 * URLs must remain intact.
 */
const guardResolvedUrlPattern = /(", )"https:\/\/npm\.flatt\.tech\/[^"]*"/g;

/**
 * Remove Takumi Guard proxy URLs from the nearest enclosing bun.lock.
 *
 * Bun writes the workspace root's lockfile even when an install runs from a child package. In a
 * Git checkout the search climbs to that root; without a checkout boundary it inspects only the
 * starting directory so it cannot rewrite an unrelated ancestor's lockfile. The proxy is
 * install-time policy rather than repository state: an empty resolved slot still makes Bun use the
 * configured default registry.
 *
 * @returns The normalized lockfile path, or undefined when no change was needed.
 */
export function normalizeBunLockfile(startDirPath: string): string | undefined {
  const lockfilePath = findBunLockfilePath(startDirPath);
  if (!lockfilePath) return;

  const content = fs.readFileSync(lockfilePath, 'utf8');
  const normalizedContent = content.replaceAll(guardResolvedUrlPattern, '$1""');
  if (normalizedContent === content) return;

  // An atomic write keeps an interrupted replacement from leaving a truncated bun.lock behind.
  writeFileAtomicSync(lockfilePath, normalizedContent);
  return lockfilePath;
}

function findBunLockfilePath(startDirPath: string): string | undefined {
  const resolvedStartDirPath = path.resolve(startDirPath);
  const repositoryRootDirPath = findRepositoryRootDirPath(resolvedStartDirPath);
  if (!repositoryRootDirPath) {
    const lockfilePath = path.join(resolvedStartDirPath, 'bun.lock');
    return fs.existsSync(lockfilePath) ? lockfilePath : undefined;
  }

  let dirPath = resolvedStartDirPath;
  while (true) {
    const lockfilePath = path.join(dirPath, 'bun.lock');
    if (fs.existsSync(lockfilePath)) return lockfilePath;
    if (dirPath === repositoryRootDirPath) return;

    dirPath = path.dirname(dirPath);
  }
}

function findRepositoryRootDirPath(startDirPath: string): string | undefined {
  let dirPath = startDirPath;
  while (true) {
    if (fs.existsSync(path.join(dirPath, '.git'))) return dirPath;

    const parentDirPath = path.dirname(dirPath);
    if (parentDirPath === dirPath) return;
    dirPath = parentDirPath;
  }
}
