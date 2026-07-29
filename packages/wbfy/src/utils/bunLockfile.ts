import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Anchored to `", ` so only a registry entry's `resolved` slot is cleared. A direct tarball
 * dependency can carry the same host in its workspace descriptor and tuple identifier, and those
 * URLs must remain intact.
 */
const guardResolvedUrlPattern = /(", )"https:\/\/npm\.flatt\.tech\/[^"]*"/g;

/**
 * Remove Takumi Guard proxy URLs that Bun records when wbfy runs behind the CI/developer proxy.
 *
 * The proxy is an install-time policy, not repository state. Keeping its URLs in a generated
 * bun.lock makes the next registry-agnostic install rewrite the whole lockfile and can make clients
 * send default-registry credentials to the proxy host. An empty resolved slot still lets Bun use
 * whichever default registry is configured when installing.
 */
export function normalizeBunLockfile(rootDirPath: string): boolean {
  const lockfilePath = path.join(rootDirPath, 'bun.lock');
  let content: string;
  try {
    content = fs.readFileSync(lockfilePath, 'utf8');
  } catch {
    return false;
  }

  const normalizedContent = content.replaceAll(guardResolvedUrlPattern, '$1""');
  if (normalizedContent === content) return false;

  const temporaryPath = `${lockfilePath}.wbfy-normalizing.${process.pid}.${crypto.randomUUID()}`;
  try {
    const mode = fs.statSync(lockfilePath).mode & 0o777;
    fs.writeFileSync(temporaryPath, normalizedContent, { mode });
    fs.chmodSync(temporaryPath, mode);
    fs.renameSync(temporaryPath, lockfilePath);
  } finally {
    fs.rmSync(temporaryPath, { force: true });
  }
  console.info(`Removed Takumi Guard proxy URLs from ${lockfilePath} to keep it registry-agnostic.`);
  return true;
}
