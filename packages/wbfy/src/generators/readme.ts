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
// change again; keying on either alone leaves the superseded badge behind and duplicates it. The
// alt text also keeps an unrelated image that merely links to wbfy (e.g. a diagram) from deletion.
const wbfyBadgePattern = new RegExp(
  String.raw`\[!\[wbfy\]\(https://img\.shields\.io/badge/[^)\s]*\)\]\([^)\s]*\)`,
  'gu'
);

interface MarkdownLine {
  content: string;
  end: number;
  ending: string;
  isProtected: boolean;
}

interface ProtectedSpan {
  text: string;
  isProtected: boolean;
  /** Only set for protected spans; distinguishes an inline code span from an HTML comment. */
  kind?: 'code' | 'comment';
}

interface MarkdownAnalysis {
  frontMatterEnd: number | undefined;
  lines: MarkdownLine[];
}

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
  readme = removeMarkdownMatches(readme, new RegExp(escapeRegExp(badge), 'gu'));

  const insertionAnchor = findBadgeInsertionAnchor(readme);
  if (insertionAnchor === undefined) {
    readme = readme.replace(/^(?:[ \t]*\r?\n)*/u, '');
    return `${badge}${lineEnding}${lineEnding}${readme}`;
  }

  const before = readme.slice(0, insertionAnchor);
  let after = readme
    .slice(insertionAnchor)
    .replace(/^\r?\n/u, '')
    .replace(/^(?:[ \t]*\r?\n)*/u, '');
  // Only another BADGE line may sit directly under the inserted badge. Prose that merely starts with
  // a link or an image (`[Documentation](docs.md) explains …`) would otherwise be joined into the
  // badge's paragraph by CommonMark's soft line break and render on the badge row.
  if (after && !isBadgeLine(after.slice(0, after.search(/\r?\n|$/u)))) after = `${lineEnding}${after}`;
  return `${before}${lineEnding}${lineEnding}${badge}${lineEnding}${after}`;
}

function findBadgeInsertionAnchor(readme: string): number | undefined {
  const analysis = analyzeMarkdown(readme);

  // A heading inside a collapsed `<details>` is not the repository title, and anchoring to it hides
  // the badge until the reader expands the section. `<details>` spans blank lines, so the block-level
  // HTML tracking in analyzeMarkdown cannot cover it; its open tags are counted here instead.
  let collapsedDepth = 0;

  for (let index = 0; index < analysis.lines.length; index++) {
    const line = analysis.lines[index]!;
    if (line.isProtected) continue;
    // Only VISIBLE tags open a collapsed section: a `<details>` written in a comment or an inline
    // code example would otherwise raise the depth forever and hide the real title from the anchor.
    const visibleLineContent = splitProtectedSpans(line.content)
      .filter((segment) => !segment.isProtected)
      .map((segment) => segment.text)
      .join('');
    collapsedDepth +=
      countRawHtmlTags(visibleLineContent, 'details') - countRawHtmlClosingTags(visibleLineContent, 'details');
    if (collapsedDepth > 0) continue;
    if (/^ {0,3}#(?:[ \t]+|$)/u.test(line.content)) return line.end;

    // A centered HTML title (`<h1 align="center">…</h1>`) is a title just as much as a Markdown
    // heading; without this the badge is inserted ABOVE it. The closing tag may sit on a later line.
    if (/^ {0,3}<h1(?:[ \t>]|$)/iu.test(line.content)) {
      for (let closingIndex = index; closingIndex < analysis.lines.length; closingIndex++) {
        const closingLine = analysis.lines[closingIndex]!;
        if (closingLine.isProtected) continue;
        // A `</h1>` written inside a comment or inline code closes nothing; anchoring there would put
        // the badge INSIDE the title and split the raw HTML block with blank lines.
        const visibleContent = splitProtectedSpans(closingLine.content)
          .filter((segment) => !segment.isProtected)
          .map((segment) => segment.text)
          .join('');
        if (hasRawHtmlClosingTag(visibleContent, 'h1')) return closingLine.end;
      }
    }

    const previousLine = analysis.lines[index - 1];
    if (
      previousLine &&
      !previousLine.isProtected &&
      previousLine.content.trim() &&
      !isIndentedCode(previousLine.content) &&
      /^ {0,3}(?:=+|-+)[ \t]*$/u.test(line.content)
    ) {
      return line.end;
    }
  }
  return analysis.frontMatterEnd;
}

function analyzeMarkdown(readme: string): MarkdownAnalysis {
  let inHtmlComment = false;
  let fence: { character: string; length: number } | undefined;
  let frontMatterMarker: string | undefined;
  let rawHtmlTag: string | undefined;
  let frontMatterEnd: number | undefined;
  let offset = 0;
  const lines: MarkdownLine[] = [];

  for (const lineWithEnding of readme.matchAll(/.*?(?:\r\n|\n|$)/gu)) {
    if (!lineWithEnding[0]) break;
    const fullLine = lineWithEnding[0];
    const ending = fullLine.match(/\r?\n$/u)?.[0] ?? '';
    const content = fullLine.slice(0, fullLine.length - ending.length);
    const trimmedLine = content.trim();
    const start = offset;
    const end = start + content.length;
    offset += fullLine.length;

    if (start === 0 && (trimmedLine === '---' || trimmedLine === '+++') && hasFrontMatterEnd(readme, trimmedLine)) {
      frontMatterMarker = trimmedLine;
      lines.push({ content, end, ending, isProtected: true });
      continue;
    }
    if (frontMatterMarker) {
      if (trimmedLine === frontMatterMarker) {
        frontMatterMarker = undefined;
        frontMatterEnd = end;
      }
      lines.push({ content, end, ending, isProtected: true });
      continue;
    }

    if (inHtmlComment) {
      if (content.includes('-->')) inHtmlComment = false;
      lines.push({ content, end, ending, isProtected: true });
      continue;
    }

    if (rawHtmlTag) {
      if (hasRawHtmlClosingTag(content, rawHtmlTag)) rawHtmlTag = undefined;
      lines.push({ content, end, ending, isProtected: true });
      continue;
    }

    if (fence) {
      const fenceMatch = getContainerContent(content).match(/^ {0,3}(`+|~+)[ \t]*$/u)?.[1];
      if (fenceMatch?.[0] === fence.character && fenceMatch.length >= fence.length) fence = undefined;
      lines.push({ content, end, ending, isProtected: true });
      continue;
    }

    const openingFenceMatch = getContainerContent(content).match(/^ {0,3}(`{3,}|~{3,})(.*)$/u);
    const fenceMatch = openingFenceMatch?.[1];
    const fenceInfo = openingFenceMatch?.[2] ?? '';
    if (fenceMatch && (fenceMatch[0] === '~' || !fenceInfo.includes('`'))) {
      fence = { character: fenceMatch[0]!, length: fenceMatch.length };
      lines.push({ content, end, ending, isProtected: true });
      continue;
    }

    // `div`/`table` matter most for READMEs: a centered `<div align="center">` header is a common
    // opening, and its contents stay raw HTML that the badge must not be inserted into.
    const rawHtmlOpeningTag = content.match(/^ {0,3}<(pre|script|style|textarea|div|table)(?:[ \t>]|$)/iu)?.[1];
    if (rawHtmlOpeningTag) {
      if (!hasRawHtmlClosingTag(content, rawHtmlOpeningTag)) rawHtmlTag = rawHtmlOpeningTag;
      lines.push({ content, end, ending, isProtected: true });
      continue;
    }

    // Only INLINE CODE is stripped here, never the comment spans themselves: a `<!--` shown inside
    // code (`` `<!--` ``) must not protect the rest of the file, but a real unterminated opener must
    // still put the following lines in comment state so their badge examples stay untouched.
    const codeStrippedContent = splitProtectedSpans(content)
      .filter((segment) => segment.kind !== 'code')
      .map((segment) => segment.text)
      .join('');
    const htmlCommentStart = codeStrippedContent.indexOf('<!--');
    if (htmlCommentStart !== -1 && !codeStrippedContent.includes('-->', htmlCommentStart + 4)) inHtmlComment = true;
    lines.push({
      content,
      end,
      ending,
      isProtected: isIndentedCode(content),
    });
  }
  return { frontMatterEnd, lines };
}

function getLineEnding(content: string): '\n' | '\r\n' {
  return content.includes('\r\n') ? '\r\n' : '\n';
}

function removeMarkdownMatches(readme: string, pattern: RegExp): string {
  const { lines } = analyzeMarkdown(readme);
  return lines
    .map((line) => {
      if (line.isProtected) return `${line.content}${line.ending}`;

      // A comment ANYWHERE on the line used to protect the whole line, so a managed badge trailed by
      // e.g. `<!-- managed badge -->` could never be superseded and got duplicated instead. Only the
      // commented-out spans and inline-code examples are off limits; the segments around them are
      // ordinary Markdown, wherever on the line they sit — a badge embedded in a title or a sentence
      // is just as managed as one on a line of its own, and skipping it duplicates the badge instead.
      const content = splitProtectedSpans(line.content)
        .map((segment) => (segment.isProtected ? segment.text : segment.text.replaceAll(pattern, '')))
        .join('');
      // Removing the only badge on a line leaves a blank line behind. Keeping it would add one blank
      // line per run — unbounded growth across runs — so the emptied line goes away with its badge.
      if (content !== line.content && !content.trim()) return '';
      return `${content}${line.ending}`;
    })
    .join('');
}

/**
 * Splits a line into alternating plain and protected (`<!-- … -->` comment or `` ` ``-delimited
 * inline code) segments. An unterminated comment runs to the end; an unterminated backtick run is
 * literal text, as in CommonMark.
 */
function splitProtectedSpans(content: string): ProtectedSpan[] {
  const segments: ProtectedSpan[] = [];
  let plainStart = 0;
  let index = 0;
  const pushSpan = (end: number, kind: 'code' | 'comment'): void => {
    if (plainStart < index) segments.push({ text: content.slice(plainStart, index), isProtected: false });
    segments.push({ text: content.slice(index, end), isProtected: true, kind });
    plainStart = end;
    index = end;
  };
  while (index < content.length) {
    if (content.startsWith('<!--', index)) {
      const commentEnd = content.indexOf('-->', index + 4);
      pushSpan(commentEnd === -1 ? content.length : commentEnd + 3, 'comment');
      continue;
    }
    if (content[index] === '`') {
      const fence = /^`+/u.exec(content.slice(index))![0];
      // Only a run of exactly the same length closes the span, so a longer run is skipped over.
      const closing = new RegExp('(?<!`)`{' + fence.length + '}(?!`)', 'u').exec(content.slice(index + fence.length));
      if (closing) {
        pushSpan(index + fence.length + closing.index + fence.length, 'code');
        continue;
      }
      index += fence.length;
      continue;
    }
    index++;
  }
  if (plainStart < content.length) segments.push({ text: content.slice(plainStart), isProtected: false });
  return segments;
}

function isBadgeLine(line: string): boolean {
  // Reference-style badges (`[![Build][build-image]][build-url]`) and unlinked image badges are
  // badges too; treating them as prose puts a blank line between them and the generated badge.
  return !line
    .replaceAll(/\[!\[[^\]]*\](?:\([^\s)]*\)|\[[^\]]*\])\](?:\([^\s)]*\)|\[[^\]]*\])/gu, '')
    .replaceAll(/!\[[^\]]*\](?:\([^\s)]*\)|\[[^\]]*\])/gu, '')
    .trim();
}

/**
 * Tells whether an opening front-matter delimiter is actually closed. An unclosed leading `---` is a
 * thematic break, not front matter; treating it as front matter protects the whole document and
 * hides the title from the badge anchor.
 */
function hasFrontMatterEnd(readme: string, marker: string): boolean {
  return readme
    .split(/\r?\n/u)
    .slice(1)
    .some((line) => line.trim() === marker);
}

function isIndentedCode(line: string): boolean {
  return /^(?: {4}| {0,3}\t)/u.test(line);
}

function getContainerContent(line: string): string {
  return line.replace(/^ {0,3}(?:(?:>|[-+*]|\d{1,9}[.)])[ \t]+)+/u, '');
}

function hasRawHtmlClosingTag(line: string, tag: string): boolean {
  return new RegExp(`</${tag}[ \\t]*>`, 'iu').test(line);
}

function countRawHtmlTags(line: string, tag: string): number {
  return line.match(new RegExp(`<${tag}(?:[ \\t>]|$)`, 'giu'))?.length ?? 0;
}

function countRawHtmlClosingTags(line: string, tag: string): number {
  return line.match(new RegExp(`</${tag}[ \\t]*>`, 'giu'))?.length ?? 0;
}

function removeWbfyBadge(readme: string): string {
  return removeMarkdownMatches(readme, wbfyBadgePattern);
}

export function removeGitHubActionsBadge(readme: string, badgeName: string, fileName: string): string {
  const escapedBadgeName = escapeRegExp(badgeName);
  const escapedFileName = escapeRegExp(fileName);
  return removeMarkdownMatches(
    readme,
    new RegExp(
      String.raw`\[!\[${escapedBadgeName}\]\(https://github\.com/[^/\s)]+/[^/\s)]+/actions/workflows/${escapedFileName}/badge\.svg\)\]\(https://github\.com/[^/\s)]+/[^/\s)]+/actions/workflows/${escapedFileName}\)`,
      'gu'
    )
  );
}

function escapeRegExp(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}
