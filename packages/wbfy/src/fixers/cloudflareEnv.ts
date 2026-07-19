import fs from 'node:fs';
import path from 'node:path';

import { logger } from '../logger.js';
import type { PackageConfig } from '../packageConfig.js';
import { spawnSyncAndReturnStatus, spawnSyncAndReturnStdout } from '../utils/spawnUtil.js';

const cloudflareEnvFileName = '.env.cloudflare';

/**
 * Stops tracking .env.cloudflare in Cloudflare projects that committed it before .gitignore
 * covered it. Unlike worker-configuration.d.ts, nothing regenerates the file, so `--cached` keeps
 * it on disk — but untracking cannot remediate the leak: the CLOUDFLARE_API_TOKEN it holds
 * remains in git history and must be rotated, which the prominent warning below demands.
 */
export async function untrackCloudflareEnv(config: PackageConfig): Promise<void> {
  return logger.functionIgnoringException('untrackCloudflareEnv', async () => {
    // .gitignore is ignored for already-tracked files, so a committed .env.cloudflare would stay
    // fully committable despite holding a live CLOUDFLARE_API_TOKEN.
    const tracked = spawnSyncAndReturnStdout('git', ['ls-files', '--', cloudflareEnvFileName], config.dirPath);
    if (!tracked) return;

    // Untracking a file the generated .gitignore does not actually cover (e.g. the gitignore.io
    // fetch failed, so the file was never written) would leave it untracked and dirty, so confirm
    // the managed rule applies first. `git check-ignore` also honors .git/info/exclude and global
    // excludes, which a fresh clone lacks, so the committed package .gitignore must carry the
    // managed rule itself.
    const gitignorePath = path.resolve(config.dirPath, '.gitignore');
    const hasManagedRule =
      fs.existsSync(gitignorePath) &&
      fs
        .readFileSync(gitignorePath, 'utf8')
        .split('\n')
        .some((line) => line.trim() === cloudflareEnvFileName);
    if (!hasManagedRule) return;
    // --no-index makes git report the rule that would apply, instead of reporting nothing because
    // the file is tracked.
    const isIgnored =
      spawnSyncAndReturnStatus(
        'git',
        ['check-ignore', '--quiet', '--no-index', '--', cloudflareEnvFileName],
        config.dirPath
      ) === 0;
    if (!isIgnored) return;

    // --cached keeps the file on disk: a local `wb deploy` still needs the real token in it.
    // git refuses the removal (non-zero status) e.g. when the staged content differs from both
    // HEAD and the worktree; claiming success then would leave the token tracked while telling
    // the operator it is untracked, so report the failure instead. `--force` is deliberately not
    // used: overriding git's safety check could discard a staged change the operator intended.
    const rmStatus = spawnSyncAndReturnStatus(
      'git',
      ['rm', '--cached', '--quiet', '--', cloudflareEnvFileName],
      config.dirPath
    );
    if (rmStatus !== 0) {
      console.error(
        `Failed to untrack ${path.resolve(config.dirPath, cloudflareEnvFileName)} (git rm --cached exited with ${rmStatus}); it is STILL TRACKED and holds a CLOUDFLARE_API_TOKEN. Resolve the staged state (e.g. commit or unstage pending changes) and re-run wbfy, then rotate the token.`
      );
      return;
    }
    console.error(
      `
********************************************************************************
*** SECURITY WARNING: ${path.resolve(config.dirPath, cloudflareEnvFileName)}
*** was tracked by git and has now been untracked (the file stays on disk).
*** The CLOUDFLARE_API_TOKEN it contains REMAINS IN GIT HISTORY and must be
*** ROTATED immediately (create a new token in the Cloudflare dashboard, update
*** this file and the CLOUDFLARE_API_TOKEN GitHub secret, then revoke the old
*** token). Commit the index change wbfy just staged.
********************************************************************************
`.trim()
    );
  });
}
