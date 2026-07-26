import fs from 'node:fs';
import path from 'node:path';

import chalk from 'chalk';

/** A Takumi Guard URL can only appear in bun.lock as a package's `resolved` value. */
const guardResolvedUrlPattern = /"https:\/\/npm\.flatt\.tech\/[^"]*"/g;

/**
 * Strip Takumi Guard proxy URLs from the root `bun.lock`, returning whether the file changed.
 *
 * bun records an absolute `resolved` URL for an already-locked package whenever the configured
 * registry does not serve the tarball host named in the package metadata — which is exactly what
 * the Takumi Guard proxy does. So any install run with Guard as the DEFAULT registry (CI, or a
 * developer who put it in ~/.npmrc) bakes npm.flatt.tech URLs into the lockfile, and committing
 * them pins a SHARED lockfile to one environment's mirror: every later install downloads through
 * the proxy, and a cold-cache install fails outright with 401 for anyone whose npmrc carries a
 * registry.npmjs.org token, because bun sends the default registry's credentials to whatever host
 * the lockfile names. Guard coverage does not depend on these URLs — with an empty `resolved`, bun
 * derives the download URL from the configured registry — so they are pure damage.
 *
 * wbfy generates a pre-commit hook that strips the same URLs, but that only fires at `git commit`.
 * Running this right after an install closes the window in between, where the rewritten lockfile is
 * simply the working tree's state: a bypassed hook, a commit from a tool that does not run hooks,
 * or a diff read by a human or an agent all see it. Only the Guard host is stripped; a scoped
 * registry such as Verdaccio legitimately records its own URL for private packages.
 */
export function normalizeBunLockfile(rootDirPath: string): boolean {
  const lockfilePath = path.join(rootDirPath, 'bun.lock');
  let content: string;
  try {
    content = fs.readFileSync(lockfilePath, 'utf8');
  } catch {
    // A yarn/npm project, or a repository whose lockfile is gitignored: nothing to normalize.
    return false;
  }

  const normalizedContent = content.replaceAll(guardResolvedUrlPattern, '""');
  if (normalizedContent === content) return false;

  fs.writeFileSync(lockfilePath, normalizedContent);
  console.info(chalk.green(`Removed Takumi Guard proxy URLs from ${lockfilePath} to keep it registry-agnostic.`));
  return true;
}
