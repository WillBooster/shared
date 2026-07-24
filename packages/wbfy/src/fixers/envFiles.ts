import fs from 'node:fs';
import path from 'node:path';

import { logger } from '../logger.js';
import type { PackageConfig } from '../packageConfig.js';
import { spawnSyncAndReturnRawStdout, spawnSyncAndReturnStatus } from '../utils/spawnUtil.js';

/**
 * `.env` cascade files (`.env`, `.env.local`, `.env.<mode>`, `.env.<mode>.local`, `.env.example`,
 * ...) are matched by name; `.env.cloudflare` is the deployment-credential sidecar that
 * untrackCloudflareEnv unlinks from git while keeping it on disk (a local `wb deploy` still needs
 * the real token in it), so it is excluded here.
 */
function isRemovableEnvFileName(fileName: string): boolean {
  return /^\.env(?:\.|$)/u.test(fileName) && !/^\.env\.cloudflare(?:\.|$)/u.test(fileName);
}

/**
 * Removes committed .env files from a repository that migrated to fnox (a root fnox.toml exists):
 * fnox.toml is the single committed source of environment variables, and leftover cascade files
 * would keep secrets in plaintext in the repository. Removal cannot remediate a leak — the values
 * remain in git history and must be rotated, which the prominent warning below demands.
 * Non-fnox repositories are left untouched: deleting their .env files would destroy their only
 * configuration source.
 */
export async function removeEnvFiles(rootConfig: PackageConfig): Promise<void> {
  return logger.functionIgnoringException('removeEnvFiles', async () => {
    if (!(await fs.promises.lstat(path.resolve(rootConfig.dirPath, 'fnox.toml')).catch(() => {}))) return;

    // -z + core.quotePath=false: git C-quotes non-ASCII paths by default, which would make the
    // name filter below silently miss e.g. a tracked `アプリ/.env`. Raw (untrimmed) stdout,
    // because a leading whitespace byte belongs to the first file name.
    const trackedPaths = spawnSyncAndReturnRawStdout(
      'git',
      ['-c', 'core.quotePath=false', 'ls-files', '-z', '--', '.env*', '*/.env*'],
      rootConfig.dirPath
    )
      .split('\0')
      .filter((filePath) => filePath && isRemovableEnvFileName(path.basename(filePath)));
    if (trackedPaths.length === 0) return;

    // `git rm` (not `--cached`) also deletes the files from disk: the committed values belong in
    // fnox.toml now, leftover files would only invite drift, and the removed contents stay
    // recoverable from git history. git refuses the removal (non-zero status) e.g. when the
    // staged content differs from both HEAD and the worktree; claiming success then would leave
    // the secrets tracked while telling the operator they are removed, so report the failure
    // instead. `--force` is deliberately not used: overriding git's safety check could discard a
    // staged change the operator intended.
    const absoluteTrackedPaths = trackedPaths.map((filePath) => path.resolve(rootConfig.dirPath, filePath));
    const rmStatus = spawnSyncAndReturnStatus('git', ['rm', '--quiet', '--', ...trackedPaths], rootConfig.dirPath);
    if (rmStatus !== 0) {
      console.error(
        `Failed to remove ${absoluteTrackedPaths.join(', ')} (git rm exited with ${rmStatus}); the file(s) are STILL TRACKED and may hold secrets. Resolve the staged state (e.g. commit or unstage pending changes) and re-run wbfy, then move the values into fnox.toml and rotate any secrets.`
      );
      // Automation must not treat the run as successful while the security remediation is
      // unapplied; keep processing the batch but fail the process.
      process.exitCode = 1;
      return;
    }
    console.error(
      `
********************************************************************************
*** SECURITY WARNING: the following .env file(s) were tracked by git and have
*** now been removed (fnox.toml is the single source of environment variables):
${absoluteTrackedPaths.map((filePath) => `***   ${filePath}`).join('\n')}
*** Any secrets they contained REMAIN IN GIT HISTORY and must be ROTATED.
*** Ensure every needed value is declared in fnox.toml (secrets age-encrypted),
*** then commit the removal wbfy just staged.
********************************************************************************
`.trim()
    );
  });
}
