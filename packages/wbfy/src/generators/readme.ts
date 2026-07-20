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

/** One `[![alt](image)](link)` badge, the only shape wbfy ever writes. */
const badgePattern = /\[!\[[^\]]*\]\([^\s)]*\)\]\([^\s)]*\)/gu;

/**
 * The badges wbfy owns, matched by what identifies each one regardless of the version that wrote it:
 * its alt text for wbfy's own badge (the image URL and the link have each changed once already, so
 * keying on either leaves the superseded badge behind and duplicates it), and the workflow endpoint
 * for an Actions badge (whose URL may carry a `?branch=…` query string).
 *
 * Anything else in the block belongs to whoever put it there and is left alone.
 */
const managedBadgePatterns = [
  /^\[!\[wbfy\]\(https:\/\/img\.shields\.io\/badge\/[^)\s]*\)\]\([^)\s]*\)$/u,
  /^\[!\[semantic-release\]\(https:\/\/img\.shields\.io\/badge\/[^)\s]*\)\]\([^)\s]*\)$/u,
  /^\[!\[[^\]]*\]\(https:\/\/github\.com\/[^)\s]*\/actions\/workflows\/[^)\s]*\)\]\([^)\s]*\)$/u,
];

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

    // Ordered by what a reader cares about most: the workflow badges report whether the code is
    // currently healthy, then how it is released, and last the wbfy build that configured it.
    const badges = await buildWorkflowBadges(config);
    if (fs.existsSync(path.resolve(config.dirPath, '.releaserc.json'))) badges.push(semanticReleaseBadge);
    badges.push(buildWbfyBadge(getWbfyVersionLabel() ?? 'applied'));

    // The block is written in one pass from the badges wbfy manages right now. A badge that is no
    // longer wanted — a superseded version, or one whose workflow is gone — simply is not in the
    // list, so nothing has to remove it.
    newContent = writeBadgeBlock(newContent, badges);

    await promisePool.run(() => fsUtil.generateFile(filePath, newContent, getLineEnding(newContent)));
  });
}

async function buildWorkflowBadges(config: PackageConfig): Promise<string[]> {
  const repository = config.repository?.slice(config.repository.indexOf(':') + 1);
  const workflowsPath = path.resolve(config.dirPath, '.github', 'workflows');
  if (!repository || !fs.existsSync(workflowsPath)) return [];

  const badges: string[] = [];
  for (const fileName of fs.readdirSync(workflowsPath)) {
    if (!fileName.startsWith('test') && !fileName.startsWith('deploy')) continue;
    // GitHub's badge endpoint returns 404 until the workflow has at least one run, so a badge for a
    // dispatch-only deploy workflow that has never run renders as a broken image. Test workflows run
    // on every PR, so only deploy badges need the guard.
    if (fileName.startsWith('deploy') && !(await hasAnyWorkflowRun(repository, fileName, config.isPublicRepo))) {
      continue;
    }
    const badgeName = (fileName[0] ?? '').toUpperCase() + fileName.slice(1, fileName.indexOf('.')).replace('-', ' ');
    const workflowUrl = `https://github.com/${repository}/actions/workflows/${encodeUrlPath(fileName)}`;
    badges.push(`[![${badgeName}](${workflowUrl}/badge.svg)](${workflowUrl})`);
  }
  return badges;
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
 * Replaces the badge block — the run of badge-only lines wbfy keeps directly under the title — with
 * `managedBadges`, keeping any badge there that wbfy does not manage, and reassembles the README
 * around it with exactly one blank line on each side.
 *
 * This is the module's whole job. Because the block is the only region ever read or written, the
 * rest of the README needs no understanding at all: prose, fenced examples, HTML and comments are
 * never touched, so none of the constructs a Markdown parser exists to recognize matter here.
 */
export function writeBadgeBlock(readme: string, managedBadges: string[]): string {
  const lineEnding = getLineEnding(readme);
  // The final newline is set aside rather than split into a trailing empty line, which the blank-line
  // trimming below would otherwise swallow.
  const endsWithNewline = /\r?\n$/u.test(readme);
  const lines = readme.replace(/\r?\n$/u, '').split(/\r?\n/u);

  const titleEndIndex = findTitleEndIndex(lines);
  // Without a recognizable title the block sits at the very top, above everything.
  const head = titleEndIndex === undefined ? [] : lines.slice(0, titleEndIndex + 1);
  let index = head.length;
  while (index < lines.length && !lines[index]!.trim()) index++;
  const existing: string[] = [];
  while (index < lines.length && isBadgeLine(lines[index]!)) {
    existing.push(...(lines[index++]!.match(badgePattern) ?? []));
  }
  while (index < lines.length && !lines[index]!.trim()) index++;
  const body = lines.slice(index);

  // Superseding a managed badge is just dropping the old one: a version, URL or workflow change
  // leaves no stale copy, while a badge someone else added to the block is kept.
  const badges = [...managedBadges, ...existing.filter((badge) => !isManagedBadge(badge))];
  const result = [
    ...head,
    ...(head.length > 0 && badges.length > 0 ? [''] : []),
    ...badges,
    ...(body.length > 0 && head.length + badges.length > 0 ? [''] : []),
    ...body,
  ].join(lineEnding);
  return endsWithNewline ? `${result}${lineEnding}` : result;
}

/**
 * The line index the badge block follows. Only the FIRST piece of content is examined, never the
 * whole file: a title is what a README opens with, and scanning further would mean recognizing every
 * construct a `#` could be hiding inside — exactly the Markdown parsing this module does without.
 */
function findTitleEndIndex(lines: string[]): number | undefined {
  let index = 0;
  // Front matter has to stay first in the file, so the badges go after it rather than above it.
  if (lines[0]?.trim() === '---') {
    const closingIndex = lines.findIndex((line, lineIndex) => lineIndex > 0 && line.trim() === '---');
    if (closingIndex !== -1) index = closingIndex + 1;
  }
  while (index < lines.length && !lines[index]!.trim()) index++;

  const line = lines[index];
  if (line === undefined) return undefined;
  // wbfy writes `# <name>`; any other title construct is left for manual placement.
  return /^ {0,3}#{1,6}[ \t]/u.test(line) ? index : undefined;
}

/**
 * Percent-encodes the characters that would end a Markdown destination early. A workflow file may be
 * named anything with a `.yml` extension, and one containing `(` or `)` produced a badge that wbfy's
 * own badge pattern could not read back — so the line left the block and the badge was duplicated.
 */
function encodeUrlPath(value: string): string {
  return value.replaceAll(/[()\s]/gu, (character) => `%${character.codePointAt(0)!.toString(16).toUpperCase()}`);
}

/** Whether the badge is one wbfy generates, in any version it has ever written. */
function isManagedBadge(badge: string): boolean {
  return managedBadgePatterns.some((pattern) => pattern.test(badge));
}

/** Whether the line holds badges and nothing else — the only content wbfy puts in the block. */
function isBadgeLine(line: string): boolean {
  const trimmed = line.trim();
  return !!trimmed && !trimmed.replaceAll(badgePattern, '').trim();
}

function getLineEnding(content: string): '\n' | '\r\n' {
  return content.includes('\r\n') ? '\r\n' : '\n';
}
