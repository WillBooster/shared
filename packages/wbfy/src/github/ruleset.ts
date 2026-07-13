import type { Octokit } from '@octokit/core';
import { withRetry } from '@willbooster/shared-lib/src';

import { logger } from '../logger.js';
import type { PackageConfig } from '../packageConfig.js';
import { getOctokit, gitHubUtil, hasGitHubToken } from '../utils/githubUtil.js';

interface RepositoryRulesetPayload {
  name: string;
  target: 'branch';
  enforcement: 'active';
  conditions: {
    ref_name: {
      include: string[];
      exclude: string[];
    };
  };
  rules: (
    | {
        type: 'deletion' | 'non_fast_forward';
      }
    | {
        type: 'required_status_checks';
        parameters: {
          strict_required_status_checks_policy: boolean;
          do_not_enforce_on_create: boolean;
          required_status_checks: {
            context: string;
            integration_id: number;
          }[];
        };
      }
    | {
        type: 'pull_request';
        parameters: {
          required_approving_review_count: number;
          dismiss_stale_reviews_on_push: boolean;
          required_reviewers: [];
          require_code_owner_review: boolean;
          require_last_push_approval: boolean;
          required_review_thread_resolution: boolean;
          allowed_merge_methods: ['squash'];
        };
      }
  )[];
  bypass_actors: {
    actor_id: number;
    actor_type: 'Team';
    bypass_mode: 'pull_request';
  }[];
}

interface RepositoryRulesetSummary {
  id?: number;
  name?: string;
  source_type?: string;
}

const GITHUB_API_VERSION_HEADER = {
  'X-GitHub-Api-Version': '2022-11-28',
} as const;

const GITHUB_ACTIONS_INTEGRATION_ID = 15_368;

const PROTECT_MAIN_RULESET: RepositoryRulesetPayload = {
  name: 'Protect main',
  target: 'branch',
  enforcement: 'active',
  conditions: {
    ref_name: {
      exclude: [],
      include: ['~DEFAULT_BRANCH'],
    },
  },
  rules: [
    {
      type: 'deletion',
    },
    {
      type: 'required_status_checks',
      parameters: {
        strict_required_status_checks_policy: false,
        do_not_enforce_on_create: true,
        required_status_checks: [
          {
            context: 'test / test',
            integration_id: GITHUB_ACTIONS_INTEGRATION_ID,
          },
          {
            context: 'semantic-pr / semantic-pr',
            integration_id: GITHUB_ACTIONS_INTEGRATION_ID,
          },
        ],
      },
    },
    {
      type: 'non_fast_forward',
    },
    {
      type: 'pull_request',
      parameters: {
        required_approving_review_count: 0,
        dismiss_stale_reviews_on_push: false,
        required_reviewers: [],
        require_code_owner_review: false,
        require_last_push_approval: false,
        required_review_thread_resolution: false,
        allowed_merge_methods: ['squash'],
      },
    },
  ],
  bypass_actors: [
    {
      actor_id: 17_777_495,
      actor_type: 'Team',
      bypass_mode: 'pull_request',
    },
  ],
};

export async function setupRepositoryRulesets(config: PackageConfig): Promise<void> {
  return logger.functionIgnoringException('setupRepositoryRulesets', async () => {
    const [owner, repo] = gitHubUtil.getOrgAndName(config.repository ?? '');
    if (!owner || !repo) return;
    if (owner !== 'WillBooster') return;
    if (!hasGitHubToken(owner)) return;

    const octokit = getOctokit(owner);

    try {
      await upsertProtectMainRuleset(octokit, owner, repo, buildProtectMainRuleset(config));
    } catch (error) {
      if (!isGitHubPermissionOrVisibilityError(error)) throw error;

      // Repository rulesets require administration permission, which local runs
      // may not have even when file-generation and pushes are allowed.
      console.warn('Skip setupRepositoryRulesets due to:', (error as Error | undefined)?.stack ?? error);
    }
  });
}

function buildProtectMainRuleset(config: PackageConfig): RepositoryRulesetPayload {
  const ruleset = structuredClone(PROTECT_MAIN_RULESET);
  if (config.cargoTomlDirPaths.length > 0) {
    for (const rule of ruleset.rules) {
      if (rule.type !== 'required_status_checks') continue;
      // The context is `<caller job id> / <reusable job id>` of the wbfy-generated test-rust.yml.
      rule.parameters.required_status_checks.push({
        context: 'test-rust / test-rust',
        integration_id: GITHUB_ACTIONS_INTEGRATION_ID,
      });
    }
  }
  return ruleset;
}

async function upsertProtectMainRuleset(
  octokit: Octokit,
  owner: string,
  repo: string,
  ruleset: RepositoryRulesetPayload
): Promise<void> {
  const existingRuleset = await findRepositoryRuleset(octokit, owner, repo, ruleset.name);
  const existingRulesetId = existingRuleset?.id;

  await withRetry(
    async () => {
      if (existingRulesetId) {
        await octokit.request('PUT /repos/{owner}/{repo}/rulesets/{ruleset_id}', {
          owner,
          repo,
          ruleset_id: existingRulesetId,
          ...ruleset,
          headers: GITHUB_API_VERSION_HEADER,
        });
        return;
      }

      await octokit.request('POST /repos/{owner}/{repo}/rulesets', {
        owner,
        repo,
        ...ruleset,
        headers: GITHUB_API_VERSION_HEADER,
      });
    },
    {
      shouldRetry: (error) => !isGitHubPermissionOrVisibilityError(error),
    }
  );
}

async function findRepositoryRuleset(
  octokit: Octokit,
  owner: string,
  repo: string,
  rulesetName: string
): Promise<RepositoryRulesetSummary | undefined> {
  const response = await withRetry(
    () =>
      octokit.request('GET /repos/{owner}/{repo}/rulesets', {
        owner,
        repo,
        includes_parents: false,
        targets: 'branch',
        headers: GITHUB_API_VERSION_HEADER,
      }),
    {
      shouldRetry: (error) => !isGitHubPermissionOrVisibilityError(error),
    }
  );
  const rulesets = response.data;
  if (!Array.isArray(rulesets)) return;
  return rulesets.find((ruleset) => ruleset.name === rulesetName && ruleset.source_type === 'Repository');
}

function isGitHubPermissionOrVisibilityError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const status = (error as { status?: number }).status;
  return status === 401 || status === 403 || status === 404;
}
