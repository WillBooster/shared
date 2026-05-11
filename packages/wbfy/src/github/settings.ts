import { withRetry } from '@willbooster/shared-lib/src';

import { logger } from '../logger.js';
import type { PackageConfig } from '../packageConfig.js';
import { getOctokit, gitHubUtil, hasGitHubToken } from '../utils/githubUtil.js';

export async function setupGitHubSettings(config: PackageConfig): Promise<void> {
  return logger.functionIgnoringException('setupGitHubSettings', async () => {
    const [owner, repo] = gitHubUtil.getOrgAndName(config.repository ?? '');
    if (!owner || !repo) return;
    if (owner !== 'WillBooster' && owner !== 'WillBoosterLab') return;
    if (!hasGitHubToken(owner)) return;

    const octokit = getOctokit(owner);

    try {
      // Repository settings need administration permission, unlike file generation.
      await withRetry(
        () =>
          octokit.request('PATCH /repos/{owner}/{repo}', {
            owner,
            repo,
            allow_auto_merge: true,
            allow_merge_commit: false,
            allow_squash_merge: true,
            allow_rebase_merge: false,
            allow_update_branch: true,
            delete_branch_on_merge: true,
            squash_merge_commit_title: 'PR_TITLE',
            squash_merge_commit_message: 'BLANK',
            headers: {
              'X-GitHub-Api-Version': '2022-11-28',
            },
            ...(config.repository?.startsWith('github:WillBooster/') ? { allow_auto_merge: true } : {}),
          }),
        {
          shouldRetry: (error) => !isGitHubPermissionOrVisibilityError(error),
        }
      );
    } catch (error) {
      if (!isGitHubPermissionOrVisibilityError(error)) throw error;

      // Local wbfy runs often have push permission without admin permission.
      console.warn('Skip setupGitHubSettings due to:', (error as Error | undefined)?.stack ?? error);
    }
  });
}

function isGitHubPermissionOrVisibilityError(error: unknown): boolean {
  if (!error || typeof error !== 'object' || !('status' in error)) return false;
  return error.status === 401 || error.status === 403 || error.status === 404;
}
