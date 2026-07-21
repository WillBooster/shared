import fs from 'node:fs';
import path from 'node:path';

import type { Paragraph, PhrasingContent, RootContent } from 'mdast';
import { fromMarkdown } from 'mdast-util-from-markdown';

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
 * Replaces the badge block — the badges wbfy keeps directly under the title — with `managedBadges`,
 * keeping any badge there that wbfy does not manage, and reassembles the README around it with
 * exactly one blank line on each side.
 *
 * Both the title and the block are located in a CommonMark syntax tree rather than by scanning
 * lines: only a real parser knows whether a line that looks like a badge is a badge (a paragraph of
 * linked images) or content that merely reads like one (an indented code block, a block quote, a
 * fenced example, a multiline code span, an HTML block). Everything outside the block is copied back
 * verbatim from the original text through the parser's positional offsets, so no reformatting of the
 * user's content is possible.
 */
export function writeBadgeBlock(readme: string, managedBadges: string[]): string {
  const lineEnding = getLineEnding(readme);
  // A BOM is not Markdown: left in the text it hides the `#` of the title from the parser, and
  // prepending the block ahead of it would strip the marker from the file's first byte.
  const byteOrderMark = readme.startsWith('﻿') ? '﻿' : '';
  // Front matter is delimited by the same `---` a Setext heading and a thematic break use, so it is
  // detached before parsing instead of being told apart afterwards; it also has to stay first in the
  // file, which makes it a prefix in exactly the same way the BOM is.
  const withoutMark = readme.slice(byteOrderMark.length);
  const frontMatter = withoutMark.startsWith('---')
    ? (/^---[ \t]*\r?\n[\s\S]*?^---[ \t]*(?:\r?\n|$)/mu.exec(withoutMark)?.[0] ?? '')
    : '';
  const prefix = `${byteOrderMark}${frontMatter}`;
  // The final newline is set aside rather than parsed as trailing blank space, which the blank-line
  // trimming below would otherwise swallow.
  const endsWithNewline = /\r?\n$/u.test(readme);
  const content = withoutMark.slice(frontMatter.length).replace(/\r?\n$/u, '');

  const nodes = fromMarkdown(content).children;
  // An earlier wbfy run is the normal input, and older versions recognized neither Setext nor HTML
  // titles — so they stamped the block ABOVE such a title. That leading block must not hide the
  // title from this run, or the badges stay above it forever and the new placement only ever
  // applies to READMEs wbfy has never touched.
  const leadingBlockIndex = nodes[0] && isBadgeBlockNode(nodes[0]) ? 0 : -1;
  const firstContentIndex = leadingBlockIndex + 1;
  const titleIndex = isTitleNode(nodes[firstContentIndex]) ? firstContentIndex : -1;
  // Without a recognizable title the block sits at the very top, above everything.
  const head =
    titleIndex === -1
      ? ''
      : content.slice(nodes[titleIndex]!.position!.start.offset, nodes[titleIndex]!.position!.end.offset);

  const blockNode = nodes[titleIndex === -1 ? firstContentIndex : titleIndex + 1];
  const existing = blockNode && isBadgeBlockNode(blockNode) ? readBadges(blockNode, content) : undefined;
  const bodyNode = existing && blockNode ? nodes[nodes.indexOf(blockNode) + 1] : blockNode;
  const body = bodyNode ? content.slice(bodyNode.position!.start.offset) : '';

  // Superseding a managed badge is just dropping the old one: a version, URL or workflow change
  // leaves no stale copy, while a badge someone else added to the block is kept. A block the older
  // layout left above the title is carried down here rather than dropped, so unrelated badges in it
  // survive the move.
  const relocated = leadingBlockIndex === 0 && titleIndex !== -1 ? readBadges(nodes[0] as Paragraph, content) : [];
  const badges = [...managedBadges, ...[...(existing ?? []), ...relocated].filter((badge) => !isManagedBadge(badge))];
  // Content is sliced from its node's start offset, so whatever blank space followed the front
  // matter is gone; exactly one blank line is restored here. A closing delimiter that ended at EOF
  // carries no newline of its own and needs both, or `---` would fuse with the first badge and
  // destroy them both. A BOM needs no separator: it is a byte marker, not a line.
  const separator = frontMatter ? (/\r?\n$/u.test(frontMatter) ? lineEnding : `${lineEnding}${lineEnding}`) : '';
  const result =
    prefix + separator + [head, badges.join(lineEnding), body].filter(Boolean).join(`${lineEnding}${lineEnding}`);
  return endsWithNewline ? `${result}${lineEnding}` : result;
}

/**
 * Whether the node opens the README with a title. Only the FIRST piece of content can be one: a
 * title is what a README opens with, and anchoring the badges to a heading further down would bury
 * them below content the author put first.
 */
function isTitleNode(node: RootContent | undefined): boolean {
  if (!node) return false;
  if (node.type === 'heading') return true;
  // Many READMEs center their title in HTML (`<h1>`, or a `<div>`/`<p>` wrapping one), which the
  // parser reports as one opaque HTML block; the badges go after the whole block.
  return node.type === 'html' && containsRenderedH1(node.value);
}

/**
 * Whether the HTML block actually RENDERS an `<h1>`. Comments and quoted attribute values are
 * removed first: a documentation example or a `title="<h1>"` attribute mentions the tag without
 * rendering it, and treating that as the title buries the badges below the real heading.
 */
function containsRenderedH1(html: string): boolean {
  const withoutInertText = html
    .replaceAll(/<!--[\s\S]*?(?:-->|$)/gu, '')
    .replaceAll(/"[^"]*"/gu, '""')
    .replaceAll(/'[^']*'/gu, "''");
  return /<h1[\s>]/iu.test(withoutInertText);
}

/** Whether the node is a paragraph of badges and nothing else — the only content wbfy puts in the block. */
function isBadgeBlockNode(node: RootContent): node is Paragraph {
  return (
    node.type === 'paragraph' &&
    node.children.some((child) => isBadgeNode(child)) &&
    node.children.every(
      (child) => isBadgeNode(child) || child.type === 'break' || (child.type === 'text' && !child.value.trim())
    )
  );
}

/** A badge is one `[![alt](image)](link)`, the only shape wbfy ever writes. */
function isBadgeNode(node: RootContent | PhrasingContent): boolean {
  return node.type === 'link' && node.children.length === 1 && node.children[0]?.type === 'image';
}

/**
 * The badges in the block, as the exact source text that produced them: a badge wbfy does not manage
 * is written back byte for byte instead of being re-serialized from the tree.
 */
function readBadges(node: Paragraph, content: string): string[] {
  return node.children
    .filter((child) => isBadgeNode(child))
    .map((child) => content.slice(child.position!.start.offset, child.position!.end.offset));
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

function getLineEnding(content: string): '\n' | '\r\n' {
  return content.includes('\r\n') ? '\r\n' : '\n';
}
