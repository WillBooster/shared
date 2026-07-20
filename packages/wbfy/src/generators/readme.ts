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
// Identified by what makes a badge wbfy's own — the `wbfy` alt text on a shields.io badge image —
// rather than by its exact image URL or its link. Both of those have changed once already and may
// change again; keying on either alone leaves the superseded badge behind and duplicates it.
const wbfyBadgePattern = new RegExp(
  String.raw`\[!\[wbfy\]\(https://img\.shields\.io/badge/[^)\s]*\)\]\([^)\s]*\)`,
  'gu'
);

/** One `[![alt](image)](link)` badge, the only shape wbfy ever writes. */
const badgePattern = /\[!\[[^\]]*\]\([^\s)]*\)\]\([^\s)]*\)/gu;

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
    newContent = removeBadges(newContent, wbfyBadgePattern);
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

/**
 * Rewrites the badge block — the run of badge-only lines wbfy keeps directly under the title —
 * through `transform`, and reassembles the README around it with exactly one blank line on each
 * side.
 *
 * Confining every edit to this block is what keeps this module small. wbfy only ever writes badges
 * here, and it only ever reads back its own output, so nothing else in the README has to be
 * understood: prose, fenced examples, HTML and comments are simply never touched.
 */
function rewriteBadgeBlock(readme: string, transform: (badges: string[]) => string[]): string {
  const lineEnding = getLineEnding(readme);
  // The final newline is set aside rather than split into a trailing empty line, which the blank-line
  // trimming below would otherwise swallow.
  const endsWithNewline = /\r?\n$/u.test(readme);
  const lines = readme.replace(/\r?\n$/u, '').split(/\r?\n/u);

  const titleIndex = findTitleIndex(lines);
  // Without a title the block sits at the very top, above everything.
  const head = titleIndex === undefined ? [] : lines.slice(0, titleIndex + 1);
  let index = head.length;
  while (index < lines.length && !lines[index]!.trim()) index++;
  const badges: string[] = [];
  while (index < lines.length && isBadgeLine(lines[index]!)) badges.push(lines[index++]!.trim());
  while (index < lines.length && !lines[index]!.trim()) index++;
  const body = lines.slice(index);

  const newBadges = transform(badges);
  const result = [
    ...head,
    ...(head.length > 0 && newBadges.length > 0 ? [''] : []),
    ...newBadges,
    ...(body.length > 0 && head.length + newBadges.length > 0 ? [''] : []),
    ...body,
  ].join(lineEnding);
  return endsWithNewline ? `${result}${lineEnding}` : result;
}

/** The line index of the README's title, which the badge block follows. */
function findTitleIndex(lines: string[]): number | undefined {
  let inFence = false;
  for (const [index, line] of lines.entries()) {
    // The one piece of Markdown structure worth tracking: a leading fenced example may contain a
    // `#` line, and anchoring to it would write the badges inside the code block.
    if (/^ {0,3}(?:`{3,}|~{3,})/u.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    if (/^ {0,3}#{1,6}(?:[ \t]|$)/u.test(line)) return index;
    // A centered `<h1 align="center">…</h1>` is a title too; it may close on a later line.
    if (/^ {0,3}<h1(?:[ \t>]|$)/iu.test(line)) {
      const closingIndex = lines.findIndex(
        (candidate, candidateIndex) => candidateIndex >= index && /<\/h1>/iu.test(candidate)
      );
      return closingIndex === -1 ? index : closingIndex;
    }
    // A Setext underline turns the line above it into the title.
    if (index > 0 && lines[index - 1]!.trim() && /^ {0,3}(?:=+|-+)[ \t]*$/u.test(line)) return index;
  }
  return undefined;
}

export function insertBadge(readme: string, badge: string): string {
  const pattern = new RegExp(escapeRegExp(badge), 'gu');
  // The badge is dropped before being re-added, so re-running replaces it instead of stacking a
  // second copy.
  return rewriteBadgeBlock(readme, (badges) => [badge, ...stripBadges(badges, pattern)]);
}

export function removeGitHubActionsBadge(readme: string, badgeName: string, fileName: string): string {
  const escapedFileName = escapeRegExp(fileName);
  return removeBadges(
    readme,
    new RegExp(
      // The query string GitHub's UI puts on badge URLs (`?branch=…`) is optional on both.
      String.raw`\[!\[${escapeRegExp(badgeName)}\]\(https://github\.com/[^/\s)]+/[^/\s)]+/actions/workflows/${escapedFileName}/badge\.svg(?:\?[^)\s]*)?\)\]\(https://github\.com/[^/\s)]+/[^/\s)]+/actions/workflows/${escapedFileName}(?:\?[^)\s]*)?\)`,
      'gu'
    )
  );
}

function removeBadges(readme: string, pattern: RegExp): string {
  return rewriteBadgeBlock(readme, (badges) => stripBadges(badges, pattern));
}

function stripBadges(badges: string[], pattern: RegExp): string[] {
  // A line holding nothing but the removed badge goes away with it; keeping it would add a blank
  // line on every run.
  return badges.map((line) => line.replaceAll(pattern, '').trim()).filter(Boolean);
}

/** Whether the line holds badges and nothing else — the only content wbfy puts in the block. */
function isBadgeLine(line: string): boolean {
  const trimmed = line.trim();
  return !!trimmed && !trimmed.replaceAll(badgePattern, '').trim();
}

function getLineEnding(content: string): '\n' | '\r\n' {
  return content.includes('\r\n') ? '\r\n' : '\n';
}

function escapeRegExp(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}
