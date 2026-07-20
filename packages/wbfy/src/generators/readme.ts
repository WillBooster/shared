import fs from 'node:fs';
import path from 'node:path';

import { logger } from '../logger.js';
import type { PackageConfig } from '../packageConfig.js';
import { fsUtil } from '../utils/fsUtil.js';
import { getOctokit } from '../utils/githubUtil.js';
import { promisePool } from '../utils/promisePool.js';
import { getWbfyVersionLabel } from '../utils/version.js';

const semanticReleaseBadge =
  '[![semantic-release](https://img.shields.io/badge/%20%20%F0%9F%93%A6%F0%9F%9A%80-semantic--release-e10079.svg)](https://github.com/semantic-release/semantic-release)';

const wbfyBadgeUrlPrefix = 'https://img.shields.io/badge/wbfy-';
const wbfyBadgeLink = 'https://github.com/WillBooster/shared/tree/main/packages/wbfy';

function buildWbfyBadge(label: string): string {
  // Hyphens are escaped as `--` per shields.io's badge path syntax, so `v1.2.3-rc.1` stays intact.
  return `[![wbfy](${wbfyBadgeUrlPrefix}${label.replaceAll('-', '--')}-1e90ff.svg)](${wbfyBadgeLink})`;
}

export async function generateReadme(config: PackageConfig): Promise<void> {
  return logger.functionIgnoringException('generateReadme', async () => {
    const filePath = path.resolve(config.dirPath, 'README.md');
    // The wbfy badge marks a repository as wbfied, so a repository without a README still gets one.
    // readFileIfExists falls back ONLY on ENOENT: a README that exists but cannot be read (e.g.
    // permissions, EMFILE) must abort the generator instead of being overwritten with the stub.
    let newContent =
      (await fsUtil.readFileIfExists(filePath)) ??
      `# ${config.packageJson?.name ?? path.basename(path.resolve(config.dirPath))}\n`;

    // Drop any previously inserted badge first, so a version or link change leaves no stale one.
    newContent = removeWbfyBadge(newContent);
    newContent = insertBadge(newContent, buildWbfyBadge(getWbfyVersionLabel() ?? 'applied'));

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

    await promisePool.run(() => fsUtil.generateFile(filePath, newContent, getLineEnding(newContent)));
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
  const lineEnding = getLineEnding(readme);
  readme = collapseBlankLines(readme.replace(badge, ''), lineEnding);

  const headingEnd = findTopLevelHeadingEnd(readme);
  if (headingEnd === undefined) return `${badge}${lineEnding}${lineEnding}${readme}`;

  const before = readme.slice(0, headingEnd);
  let after = readme.slice(headingEnd);
  if (after.startsWith(lineEnding)) after = after.slice(lineEnding.length);
  if (!after.startsWith(lineEnding)) after = `${lineEnding}${after}`;
  return `${before}${lineEnding}${lineEnding}${badge}${lineEnding}${after}`;
}

function findTopLevelHeadingEnd(readme: string): number | undefined {
  let inHtmlComment = false;
  let fence: { character: string; length: number } | undefined;
  let frontMatterMarker: string | undefined;
  let offset = 0;

  for (const lineWithEnding of readme.matchAll(/.*?(?:\r\n|\n|$)/gu)) {
    if (!lineWithEnding[0]) break;
    const line = lineWithEnding[0].replace(/\r?\n$/u, '');
    const trimmedLine = line.trim();

    if (offset === 0 && (trimmedLine === '---' || trimmedLine === '+++')) {
      frontMatterMarker = trimmedLine;
      offset += lineWithEnding[0].length;
      continue;
    }
    if (frontMatterMarker) {
      if (trimmedLine === frontMatterMarker) frontMatterMarker = undefined;
      offset += lineWithEnding[0].length;
      continue;
    }

    if (inHtmlComment) {
      if (line.includes('-->')) inHtmlComment = false;
      offset += lineWithEnding[0].length;
      continue;
    }
    if (line.includes('<!--')) {
      if (!line.includes('-->', line.indexOf('<!--') + 4)) inHtmlComment = true;
      offset += lineWithEnding[0].length;
      continue;
    }

    const fenceMatch = line.match(/^[ \t]{0,3}(`{3,}|~{3,})/u);
    if (fenceMatch?.[1]) {
      if (!fence) {
        fence = { character: fenceMatch[1][0]!, length: fenceMatch[1].length };
      } else if (fenceMatch[1][0] === fence.character && fenceMatch[1].length >= fence.length) {
        fence = undefined;
      }
      offset += lineWithEnding[0].length;
      continue;
    }

    if (!fence && /^[ \t]{0,3}#(?:[ \t]+|$)/u.test(line)) return offset + line.length;
    offset += lineWithEnding[0].length;
  }
  return undefined;
}

function getLineEnding(content: string): '\n' | '\r\n' {
  return content.includes('\r\n') ? '\r\n' : '\n';
}

function collapseBlankLines(content: string, lineEnding: '\n' | '\r\n'): string {
  return content.replaceAll(/(?:\r?\n){3,}/gu, `${lineEnding}${lineEnding}`);
}

// Matched by the badge's LINK, not by its image URL: every wbfy badge wbfy ever generated points
// here, so a badge whose image URL changed (e.g. the version-less one this badge replaced) is still
// recognized as managed and gets superseded instead of duplicated.
const wbfyBadgePattern = new RegExp(String.raw`\[!\[[^\]]*\]\([^)\s]*\)\]\(${escapeRegExp(wbfyBadgeLink)}\)`, 'u');

function removeWbfyBadge(readme: string): string {
  const lineEnding = getLineEnding(readme);
  return collapseBlankLines(
    readme.replaceAll(new RegExp(`${wbfyBadgePattern.source}(?:\\r?\\n)?`, 'gu'), ''),
    lineEnding
  );
}

export function removeGitHubActionsBadge(readme: string, badgeName: string, fileName: string): string {
  const escapedBadgeName = escapeRegExp(badgeName);
  const escapedFileName = escapeRegExp(fileName);
  const lineEnding = getLineEnding(readme);
  return collapseBlankLines(
    readme.replaceAll(
      new RegExp(
        String.raw`\[!\[${escapedBadgeName}\]\(https://github\.com/[^/\s)]+/[^/\s)]+/actions/workflows/${escapedFileName}/badge\.svg\)\]\(https://github\.com/[^/\s)]+/[^/\s)]+/actions/workflows/${escapedFileName}\)(?:\r?\n)?`,
        'gu'
      ),
      ''
    ),
    lineEnding
  );
}

function escapeRegExp(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}
