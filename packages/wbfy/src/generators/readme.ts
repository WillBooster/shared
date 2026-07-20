import fs from 'node:fs';
import path from 'node:path';

import { logger } from '../logger.js';
import type { PackageConfig } from '../packageConfig.js';
import { fsUtil } from '../utils/fsUtil.js';
import { getOctokit } from '../utils/githubUtil.js';
import { promisePool } from '../utils/promisePool.js';

const semanticReleaseBadge =
  '[![semantic-release](https://img.shields.io/badge/%20%20%F0%9F%93%A6%F0%9F%9A%80-semantic--release-e10079.svg)](https://github.com/semantic-release/semantic-release)';

const wbfyBadgeUrl = 'https://img.shields.io/badge/-wbfy-1e90ff.svg';
const wbfyBadge = `[![wbfy](${wbfyBadgeUrl})](https://github.com/WillBooster/shared/tree/main/packages/wbfy)`;

export async function generateReadme(config: PackageConfig): Promise<void> {
  return logger.functionIgnoringException('generateReadme', async () => {
    const filePath = path.resolve(config.dirPath, 'README.md');
    // The wbfy badge marks a repository as wbfied, so a repository without a README still gets one.
    let newContent =
      (await fs.promises.readFile(filePath, 'utf8').catch(() => {})) ??
      `# ${config.packageJson?.name ?? path.basename(path.resolve(config.dirPath))}\n`;

    // Drop any previously inserted badge first, so a link or label change does not leave a stale one.
    newContent = removeWbfyBadge(newContent);
    newContent = insertBadge(newContent, wbfyBadge);

    if (fs.existsSync(path.resolve(config.dirPath, '.releaserc.json'))) {
      newContent = insertBadge(newContent, semanticReleaseBadge);
    }

    const repository = config.repository?.slice(config.repository.indexOf(':') + 1);
    const workflowsPath = path.resolve(config.dirPath, '.github', 'workflows');
    const fileNames = fs.existsSync(workflowsPath) ? fs.readdirSync(workflowsPath) : [];
    for (const fileName of fileNames) {
      if (!fileName.startsWith('test') && !fileName.startsWith('deploy')) continue;

      let badgeName = fileName;
      badgeName = (badgeName[0] || '').toUpperCase() + badgeName.slice(1, badgeName.indexOf('.'));
      badgeName = badgeName.replace('-', ' ');
      if (!repository) continue;
      const badge = `[![${badgeName}](https://github.com/${repository}/actions/workflows/${fileName}/badge.svg)](https://github.com/${repository}/actions/workflows/${fileName})`;
      if (fs.existsSync(path.resolve(config.dirPath, `.github/workflows/${fileName}`))) {
        // Always drop the existing badge first, so a stale broken badge is removed even when the
        // guard below skips re-inserting it.
        newContent = removeGitHubActionsBadge(newContent, badgeName, fileName);
        // GitHub's badge endpoint returns 404 until the workflow has at least one run, so a badge
        // for a dispatch-only deploy workflow that has never run renders as a broken image.
        // Test workflows run on every PR, so only deploy badges need the guard.
        if (fileName.startsWith('deploy') && !(await hasAnyWorkflowRun(repository, fileName, config.isPublicRepo)))
          continue;
        newContent = insertBadge(newContent, badge);
      }
    }

    await promisePool.run(() => fsUtil.generateFile(filePath, newContent));
  });
}

async function hasAnyWorkflowRun(
  repository: string,
  workflowFileName: string,
  isPublicRepo: boolean
): Promise<boolean> {
  const [owner, repo] = repository.split('/');
  if (!owner || !repo) return true;
  try {
    const response = await getOctokit(owner).request('GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}/runs', {
      owner,
      repo,
      workflow_id: workflowFileName,
      per_page: 1,
    });
    return response.data.total_count > 0;
  } catch (error) {
    // For a PUBLIC repository the runs endpoint needs no authorization, so 404 reliably means the
    // workflow is absent from the remote (e.g. added locally, never pushed) — like zero runs, its
    // badge would render broken. For a PRIVATE repository GitHub also answers 404 when the token
    // is missing or under-scoped, so 404 is ambiguous there and the badge is kept.
    if ((error as { status?: number }).status === 404 && isPublicRepo) return false;
    // Keep the pre-guard behavior (insert the badge) when the check itself cannot run.
    return true;
  }
}

export function insertBadge(readme: string, badge: string): string {
  // 既にbadgeがある場合は削除
  readme = readme.replace(badge, '').replaceAll(/\n\n\n+/g, '\n\n');

  for (let i = 0; i < readme.length; i++) {
    if (readme[i - 1] === '\n' && readme[i] === '\n') {
      const before = readme.slice(0, i + 1);
      let after = readme.slice(i + 1);
      if (!after.startsWith('[') && !after.startsWith('!')) {
        after = `\n${after}`;
      }
      return `${before}${badge}\n${after}`;
    }
  }
  return `${readme}\n${badge}\n`;
}

export function removeWbfyBadge(readme: string): string {
  return readme
    .replaceAll(new RegExp(String.raw`\[!\[[^\]]*\]\(${escapeRegExp(wbfyBadgeUrl)}\)\]\([^)\s]*\)\n?`, 'gu'), '')
    .replaceAll(/\n\n\n+/g, '\n\n');
}

export function removeGitHubActionsBadge(readme: string, badgeName: string, fileName: string): string {
  const escapedBadgeName = escapeRegExp(badgeName);
  const escapedFileName = escapeRegExp(fileName);
  return readme
    .replaceAll(
      new RegExp(
        String.raw`\[!\[${escapedBadgeName}\]\(https://github\.com/[^/\s)]+/[^/\s)]+/actions/workflows/${escapedFileName}/badge\.svg\)\]\(https://github\.com/[^/\s)]+/[^/\s)]+/actions/workflows/${escapedFileName}\)\n?`,
        'gu'
      ),
      ''
    )
    .replaceAll(/\n\n\n+/g, '\n\n');
}

function escapeRegExp(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}
