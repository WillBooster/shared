import { withRetry } from '@willbooster/shared-lib';

import type { PackageConfig } from '../packageConfig.js';
import { getOctokit, gitHubUtil, hasGitHubToken } from '../utils/githubUtil.js';

export async function setupGitHubSettings(config: PackageConfig): Promise<void> {
  const [owner, repo] = gitHubUtil.getOrgAndName(config.repository ?? '');
  if (!owner || !repo) return;
  if (owner !== 'WillBooster' && owner !== 'WillBoosterLab') return;
  if (!hasGitHubToken(owner)) return;

  const octokit = getOctokit(owner);

  // Administration permission
  await withRetry(() =>
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
    })
  );
}
