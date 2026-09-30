// Before semantic-release runs, `wb release` completes a release that a failed run left pending at an older commit:
// the reusable workflow skips re-runs of a run whose commit is no longer the branch head, and semantic-release would
// compute the pending version again for the newer commit. The pending release is completed first, in a run of the
// release workflow dispatched on a temporary branch at its commit, because both registries attest the commit of the
// publishing run and the version tag must not exist before both hold the version; that run dispatches the workflow on
// the release branch again to release the newer commits.

import { execFileSync } from 'node:child_process';

import { z } from 'zod';

import {
  assertDefaultTagFormat,
  fetchPublishedCommits,
  findDraftRelease,
  listPendingReleases,
  publishRelease,
  releasePluginName,
  runBuildScript,
} from './draftRelease.js';
import type { ChildTracker, ReleasePluginConfig } from './draftRelease.js';
import { createGitHubClient } from './http.js';
import type { GitHubClient } from './http.js';

const pendingBranchPrefix = 'release-pending/';
// The release workflow file, which the registries trust for publishing.
const releaseWorkflowRoute = 'actions/workflows/release.yml';
const notStartedStatuses = new Set(['pending', 'queued', 'requested', 'waiting']);

interface PendingReleaseContext {
  config: ReleasePluginConfig;
  cwd: string;
  env: Record<string, string | undefined>;
  github: GitHubClient;
  head: string;
  dryRun: boolean;
  activeChild: ChildTracker;
}

/**
 * Completes or defers to a pending release, and returns whether semantic-release should run afterwards. A dry run takes
 * the same path as a real run but only reports the remote writes it would make.
 */
export async function handlePendingReleases({
  config,
  cwd,
  env,
  releaseBranches,
  tagFormat,
  wbDryRun,
  forwardedArgs,
  activeChild,
}: {
  config: ReleasePluginConfig;
  cwd: string;
  env: Record<string, string | undefined>;
  releaseBranches: unknown;
  tagFormat: unknown;
  wbDryRun: boolean;
  forwardedArgs: string[];
  activeChild: ChildTracker;
}): Promise<boolean> {
  const { dryRun, branch: branchOption } = parseForwardedArgs(forwardedArgs, env);
  assertDefaultTagFormat(tagFormat);
  const releaseBranch = branchOption ?? parseReleaseBranch(releaseBranches);
  const github = createGitHubClient(env);
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim();
  const context = { config, cwd, env, github, head, dryRun: wbDryRun || dryRun, activeChild };
  // A run on `ref` that has not started yet does what a dispatch would, so a re-run after a lost response or a failure
  // after the dispatch never queues a second run, which on a pending-release branch would publish the version again.
  const dispatch = async (ref: string): Promise<void> => {
    if (await findActiveRun(github, ref)) {
      console.info(`A queued run on ${ref} takes over.`);
      return;
    }
    await github('POST', `${releaseWorkflowRoute}/dispatches`, { ref }, () => findActiveRun(github, ref));
    console.info(`Dispatched a run on ${ref}.`);
  };

  const refName = env.GITHUB_REF_NAME;
  if (refName?.startsWith(pendingBranchPrefix)) {
    await completePendingRelease(context, refName.slice(pendingBranchPrefix.length));
    if (context.dryRun) {
      console.info(`Would dispatch a run on ${releaseBranch} and delete the branch ${refName}.`);
    } else {
      await dispatch(releaseBranch);
      // After the dispatch, since the reusable workflow skips re-runs on a deleted branch.
      await github('DELETE', `git/refs/heads/${refName}`);
    }
    return false;
  }
  return !(await deferToPendingRelease(context, dispatch));
}

/**
 * Returns the branch that a run completing a pending release dispatches the release workflow on next. semantic-release's
 * default `branches` name several candidates and no single release branch, so the configuration must name it first.
 */
function parseReleaseBranch(branches: unknown): string {
  // semantic-release also accepts a single branch outside an array.
  const branchList = Array.isArray(branches) || branches === undefined ? branches : [branches];
  const first = z.tuple([z.union([z.string(), z.object({ name: z.string() })])], z.unknown()).safeParse(branchList)
    .data?.[0];
  if (first === undefined) {
    throw new Error(
      `${releasePluginName} requires the semantic-release option \`branches\` to name the release branch first.`
    );
  }
  return typeof first === 'string' ? first : first.name;
}

/**
 * Reads the arguments that `wb release` forwards to semantic-release and returns whether semantic-release runs dry: the
 * arguments request it, or the run is outside CI without `--no-ci`. Only `--dry-run`, `-d`, `--debug`, `--no-ci`, and
 * `--branches <branch>` are accepted: semantic-release's parser accepts many more spellings of them (e.g., `--d`,
 * `--dry-run=true`, `-vd`, `--ci=false`), and a spelling misread here would make remote writes in a dry run, or skip
 * them in a run that semantic-release reads as real.
 */
function parseForwardedArgs(
  args: string[],
  env: Record<string, string | undefined>
): { dryRun: boolean; branch?: string } {
  let dryRun = false;
  let branch: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === '--dry-run' || arg === '-d') {
      dryRun = true;
    } else if (arg === '--branches' && /^[^-,][^,]*$/.test(args[index + 1] ?? '')) {
      branch = args[++index];
    } else if (arg !== '--debug' && arg !== '--no-ci') {
      throw new Error(
        `Unsupported argument \`${arg}\`: with ${releasePluginName}, \`wb release\` forwards only --dry-run, -d, --debug, --no-ci, and --branches <branch> to semantic-release.`
      );
    }
  }
  // semantic-release detects CI as env-ci does without a known CI service.
  return { dryRun: dryRun || (!env.CI && !args.includes('--no-ci')), branch };
}

async function completePendingRelease(context: PendingReleaseContext, tag: string): Promise<void> {
  const { config, cwd, env, github, head, dryRun, activeChild } = context;
  const draft = await findDraftRelease(github, tag);
  if (!draft) {
    // A previous attempt of this run published it; this attempt still hands over to the release branch.
    console.info(`The release ${tag} is not pending.`);
    return;
  }
  if (draft.target_commitish !== head) {
    throw new Error(`The draft release ${tag} targets ${draft.target_commitish}, not ${head}.`);
  }
  if (dryRun) {
    console.info(`Would build and publish the pending release ${tag}.`);
    return;
  }
  const version = tag.replace(/^v/, '');
  await runBuildScript(cwd, env, version, activeChild);
  await publishRelease({ config, cwd, env, logger: console, draft, version, tracker: activeChild });
}

/** Returns whether a pending release of an older commit must be completed before releasing this commit. */
async function deferToPendingRelease(
  { config, cwd, github, head, dryRun }: PendingReleaseContext,
  dispatch: (ref: string) => Promise<void>
): Promise<boolean> {
  // Oldest first, since versions are released in order.
  const drafts = await listPendingReleases(github);
  for (const draft of drafts.toReversed()) {
    const commit = draft.target_commitish;
    const version = draft.tag_name.replace(/^v/, '');
    // semantic-release computes the same version again for the same commit and resumes the release itself.
    if (commit === head || !/^\d+\.\d+\.\d+/.test(version)) continue;

    const published = await fetchPublishedCommits({ ...config, cwd, version });
    if (published.every((target) => target.commit === undefined)) {
      // Nothing was released, so the version goes to the newer commits instead. A release that failed on a defect
      // (e.g., a packaging error) thus does not block the commit that fixes it.
      console.info(
        `${dryRun ? 'Would delete' : 'Deleting'} the draft release ${draft.tag_name} of ${commit}, which no registry holds`
      );
      if (!dryRun) await github('DELETE', `releases/${draft.id}`);
      continue;
    }

    const branch = `${pendingBranchPrefix}${draft.tag_name}`;
    if (dryRun) {
      console.info(`Would dispatch a run on ${branch} to complete the release before releasing this commit.`);
      return true;
    }
    await createBranch(github, branch, commit);
    // That run releases this commit next.
    await dispatch(branch);
    return true;
  }
  return false;
}

/**
 * Returns a release workflow run on `branch` that has not started yet. Since the release workflow's concurrency group
 * runs one run at a time, such a run starts after this one and runs `wb release` at the branch head, which is what a
 * dispatch on `branch` would do.
 */
async function findActiveRun(github: GitHubClient, branch: string): Promise<unknown> {
  const { workflow_runs: runs } = z
    .object({ workflow_runs: z.array(z.object({ status: z.string() })) })
    .parse(await github('GET', `${releaseWorkflowRoute}/runs?branch=${encodeURIComponent(branch)}`));
  return runs.find((run) => notStartedStatuses.has(run.status));
}

async function createBranch(github: GitHubClient, branch: string, commit: string): Promise<void> {
  try {
    await github('POST', 'git/refs', { ref: `refs/heads/${branch}`, sha: commit });
  } catch (error) {
    // An earlier attempt created it.
    const existing = await github('GET', `git/ref/heads/${branch}`).catch(() => {});
    if (z.object({ object: z.object({ sha: z.string() }) }).safeParse(existing).data?.object.sha !== commit) {
      throw error;
    }
  }
}
