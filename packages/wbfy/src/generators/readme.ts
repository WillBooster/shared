import fs from 'node:fs';
import path from 'node:path';

import type { Image, Link, Paragraph, PhrasingContent, RootContent } from 'mdast';
import { fromMarkdown } from 'mdast-util-from-markdown';

import { logger } from '../logger.js';
import { jobsAllCallReusableWorkflow } from './workflow.js';
import type { PackageConfig } from '../packageConfig.js';
import { fsUtil } from '../utils/fsUtil.js';
import { getOctokit } from '../utils/githubUtil.js';
import { promisePool } from '../utils/promisePool.js';
import { getWbfyVersionLabel } from '../utils/version.js';

const semanticReleaseBadge =
  '[![semantic-release](https://img.shields.io/badge/%20%20%F0%9F%93%A6%F0%9F%9A%80-semantic--release-e10079.svg)](https://github.com/semantic-release/semantic-release)';

const wbfyBadgeUrlPrefix = 'https://img.shields.io/badge/wbfy-';
const wbfyBadgeUrlSuffix = '-1e90ff.svg';
const wbfyBadgeLink = 'https://github.com/WillBooster/shared/tree/main/packages/wbfy';

const npmPackageUrlPrefix = 'https://www.npmjs.com/package/';

const managedBadgePatterns = [
  /^\[!\[wbfy\]\(https:\/\/img\.shields\.io\/badge\/wbfy-[^)\s]+-1e90ff\.svg\)\]\(https:\/\/github\.com\/WillBooster\/shared\/tree\/main\/packages\/wbfy\)$/u,
  /^\[!\[[^\]]*\]\((https:\/\/github\.com\/[^)\s]+\/actions\/workflows\/[^)\s]+)\/badge\.svg\)\]\(\1\)$/u,
  // Any badge linking to an npm package page, whatever image it shows and however the link is
  // spelled: the block is wbfy's, it writes at most one npm badge, so a badge for a renamed or
  // unpublished package is a stale copy of that one — not another badge to keep beside it.
  /^\[!\[[^\]]*\]\([^)\s]+\)\]\(https?:\/\/(?:www\.)?npmjs\.com\/package\/[^)\s]*\)$/u,
];

function buildWbfyBadge(label: string): string {
  // Hyphens are escaped as `--` per shields.io's badge path syntax, so `v1.2.3-rc.1` stays intact.
  return `[![wbfy](${wbfyBadgeUrlPrefix}${label.replaceAll('-', '--')}${wbfyBadgeUrlSuffix})](${wbfyBadgeLink})`;
}

/** The version label the wbfy badge in the repository's README records, i.e. the build that wbfied it. */
export async function readAppliedWbfyVersionLabel(dirPath: string): Promise<string | undefined> {
  // Confined, and tolerant of any read failure: a README that resolves outside the repository (a
  // committed symlink) or cannot be read at all says nothing about which build configured THIS
  // repository, and the answer only ever suppresses work — so anything but a readable in-repository
  // README means "not known to be applied" and the run proceeds.
  const readme = await fsUtil.readFileConfinedIfExists(path.resolve(dirPath, 'README.md')).catch(() => {});
  if (readme === undefined) return undefined;

  // The README is parsed rather than scanned, for the same reason writeBadgeBlock parses it, and
  // only the shape writeBadgeBlock itself writes counts as an applied badge: a top-level paragraph
  // of badges. A badge anywhere else is content that merely mentions one — a fenced example (wbfy's
  // own documentation has those), a block quote, a list item — and reading it as applied would skip
  // every fixer for the repository.
  for (const node of fromMarkdown(readme).children) {
    if (!isBadgeBlockNode(node)) continue;
    for (const badge of node.children) {
      if (!isBadgeNode(badge)) continue;
      const { url } = badge.children[0];
      if (url.startsWith(wbfyBadgeUrlPrefix) && url.endsWith(wbfyBadgeUrlSuffix)) {
        return url.slice(wbfyBadgeUrlPrefix.length, -wbfyBadgeUrlSuffix.length).replaceAll('--', '-');
      }
    }
  }
  return undefined;
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

    // Ordered by what a reader cares about most: the npm badge names the package a reader installs,
    // then the workflow badges report whether the code is currently healthy, then how it is
    // released, and last the wbfy build that configured it.
    const badges: string[] = [];
    const npmPackageName = await getPublishedNpmPackageName(config);
    if (npmPackageName) badges.push(buildNpmBadge(npmPackageName));
    badges.push(...(await buildWorkflowBadges(config)));
    if (fs.existsSync(path.resolve(config.dirPath, '.releaserc.json'))) badges.push(semanticReleaseBadge);
    badges.push(buildWbfyBadge(getWbfyVersionLabel() ?? 'applied'));

    // The block is written in one pass from the badges wbfy manages right now. A badge that is no
    // longer wanted — a superseded version, or one whose workflow is gone — simply is not in the
    // list, so nothing has to remove it.
    newContent = writeBadgeBlock(newContent, badges);

    await promisePool.run(() => fsUtil.generateFile(filePath, newContent, getLineEnding(newContent)));
  });
}

/**
 * The npm package name the repository publishes from its root manifest, if any. A manifest no
 * release publishes, or one kept out of the registry on purpose, has no package page to link to.
 */
async function getPublishedNpmPackageName(config: PackageConfig): Promise<string | undefined> {
  const packageJson = config.packageJson;
  if (!packageJson?.name || !config.release.npm) return undefined;
  // `private` is read the way generatePackageJson writes it: it removes the flag from a MONOREPO
  // root that declares publishing intent, so reading the flag alone would deny the badge to the
  // very manifest the same run makes publishable. Anywhere else the flag stands as written.
  const declaresPublishingIntent = !!packageJson.publishConfig || config.release.npmPublishesRoot;
  if (packageJson.private && !(config.doesContainSubPackageJsons && declaresPublishingIntent)) return undefined;
  // The manifest only says the repository INTENDS to publish: a monorepo root that configures
  // @semantic-release/npm for its workspaces is never on npm itself, and a package's first release
  // has not happened yet. Both would render a broken badge, so the registry decides.
  return (await isMissingFromNpmRegistry(packageJson.name)) ? undefined : packageJson.name;
}

/**
 * Whether the registry answers that it has no such package — the ONLY answer that removes a badge.
 * A check that cannot run (offline, an outage, a timeout) says nothing about the package, and
 * treating it as absent would strip the badge out of every published repository wbfy touches
 * during the outage and put it back afterwards.
 */
async function isMissingFromNpmRegistry(packageName: string): Promise<boolean> {
  try {
    // The scope separator must survive as a path segment, so the name is encoded piecewise.
    const encodedName = packageName.split('/').map(encodeURIComponent).join('/');
    // A badge is decoration: a stalled registry connection must not hold the whole run for however
    // long the networking stack would wait.
    const response = await fetch(`https://registry.npmjs.org/${encodedName}`, {
      method: 'HEAD',
      signal: AbortSignal.timeout(10_000),
    });
    return response.status === 404;
  } catch {
    return false;
  }
}

function buildNpmBadge(packageName: string): string {
  return `[![npm version](https://img.shields.io/npm/v/${packageName}.svg)](${npmPackageUrlPrefix}${packageName})`;
}

async function buildWorkflowBadges(config: PackageConfig): Promise<string[]> {
  const repository = config.repository?.slice(config.repository.indexOf(':') + 1);
  const workflowsPath = path.resolve(config.dirPath, '.github', 'workflows');
  if (!repository || !fs.existsSync(workflowsPath)) return [];

  // Workflow and README generation run concurrently. Do not retain a stale Rust badge while the
  // workflow generator removes a caller created from a formerly misdetected local cache — but
  // mirror its ownership check: a custom same-named workflow survives, so its badge must too.
  // Decided synchronously before the loop's first await: the generator's delete can only land at
  // an await point, and a post-delete read would misreport the wbfy-owned caller as custom.
  // No existsSync pre-check: the helper already treats a missing file as not owned, and this runs
  // once per repository, so the exceptional ENOENT read costs nothing worth a redundant stat.
  const dropsTestRustBadge =
    config.cargoTomlDirPaths.length === 0 && jobsAllCallReusableWorkflow(workflowsPath, 'test-rust.yml', 'test-rust');

  const badges: string[] = [];
  for (const fileName of fs.readdirSync(workflowsPath)) {
    if (!fileName.startsWith('test') && !fileName.startsWith('deploy')) continue;
    if (fileName === 'test-rust.yml' && dropsTestRustBadge) continue;
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
  // A leading badge block is the user's own layout: it stays above the title, and wbfy's block goes below.
  const keepsLeadingBlock = !!nodes[0] && isBadgeBlockNode(nodes[0]) && isTitleNode(nodes[1]);
  const titleIndex = keepsLeadingBlock ? 1 : isTitleNode(nodes[0]) ? 0 : -1;
  // Without a recognizable title the block sits at the very top, above everything.
  const headStartNode = keepsLeadingBlock ? nodes[0]! : nodes[titleIndex];
  const head =
    titleIndex === -1
      ? ''
      : content.slice(startOffsetWithIndent(content, headStartNode!), nodes[titleIndex]!.position!.end.offset);

  const blockNode = nodes[titleIndex + 1];
  const existing = blockNode && isBadgeBlockNode(blockNode) ? readBadges(blockNode, content) : undefined;
  const bodyNode = existing && blockNode ? nodes[nodes.indexOf(blockNode) + 1] : blockNode;
  const body = bodyNode ? content.slice(startOffsetWithIndent(content, bodyNode)) : '';

  // Superseding a managed badge is just dropping the old one: a version or workflow change leaves
  // no stale copy, while any other badge in the block (including a non-canonical wbfy badge, which
  // is removed manually) is kept.
  const badges = [...managedBadges, ...(existing ?? []).filter((badge) => !isManagedBadge(badge))];
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
 * A node's start offset, extended back over the leading whitespace on its own line. CommonMark
 * allows one to three spaces of indentation before a block, and mdast reports the offset AFTER
 * them — so slicing from it silently reindents content this generator promises to copy verbatim.
 */
function startOffsetWithIndent(content: string, node: RootContent): number {
  const start = node.position!.start.offset!;
  const lineStart = content.lastIndexOf('\n', start - 1) + 1;
  return /^[ \t]*$/u.test(content.slice(lineStart, start)) ? lineStart : start;
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
 * Whether the HTML block unambiguously RENDERS an `<h1>` — the centered-title layout many READMEs
 * use (`<h1>`, or a `<div>`/`<p>` wrapping one).
 *
 * Deliberately NOT a general HTML parser. Deciding this exactly requires the real tokenizer's
 * states — raw text, RCDATA, script data, attribute values, template contents, declarations — and
 * approximating them with regexes is the same losing game the Markdown scanning this module
 * replaced was playing. So the rule is: tokenize only the simple case, and treat anything carrying
 * a construct whose parsing depends on those states as NOT a title. Being wrong that way puts the
 * badges at the top of the file, which is merely unhelpful; being wrong the other way rewrites the
 * user's README around the wrong anchor.
 */
function containsRenderedH1(html: string): boolean {
  // Comments cannot nest and end unambiguously, so they are simply removed rather than disqualifying.
  const withoutComments = html.replaceAll(/<!--[\s\S]*?(?:-->|$)/gu, '');
  // CDATA, processing instructions, declarations, elements whose content is raw text / RCDATA /
  // script data, and `<template>` (whose contents are inert). A quoted attribute containing `<`
  // makes even locating these unreliable, so it disqualifies the block too.
  const ambiguousConstructPattern =
    /<!\[CDATA\[|<\?|<![a-zA-Z]|<\/?(?:script|style|textarea|title|iframe|noframes|noembed|xmp|template)\b|"[^"]*<[^"]*"|'[^']*<[^']*'/iu;
  if (ambiguousConstructPattern.test(withoutComments)) return false;
  // Quoting is significant only inside a start tag, so an attribute value is consumed with its own
  // tag while quotation marks in ordinary text stay text: `<div title="&lt;h1&gt;">` does not count,
  // `"<h1>Project</h1>"` does.
  const startTagPattern = /<([a-zA-Z][^\s/>]*)(?:"[^"]*"|'[^']*'|[^>"'])*>/gu;
  for (const match of withoutComments.matchAll(startTagPattern)) {
    if (match[1]?.toLowerCase() === 'h1') return true;
  }
  return false;
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
function isBadgeNode(node: RootContent | PhrasingContent): node is Link & { children: [Image] } {
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

/** Whether the badge is one wbfy writes itself, and so may be replaced by the current block. */
function isManagedBadge(badge: string): boolean {
  return badge === semanticReleaseBadge || managedBadgePatterns.some((pattern) => pattern.test(badge));
}

function getLineEnding(content: string): '\n' | '\r\n' {
  return content.includes('\r\n') ? '\r\n' : '\n';
}
