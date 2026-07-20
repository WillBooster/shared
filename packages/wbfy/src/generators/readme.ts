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
// The surrounding link is optional: an unlinked `![wbfy](…)` image is the same managed badge, and
// leaving it behind put a second wbfy badge right under the generated one. The bare-image
// alternative must NOT match the image inside a link form this pattern does not otherwise cover
// (a link title, or a reference link): removing just the inner image would leave the wrapping
// `[](…)` behind and corrupt the README. A neighbouring `[` or `]` marks exactly those cases.
const wbfyBadgePattern = new RegExp(
  String.raw`\[!\[wbfy\]\(https://img\.shields\.io/badge/[^)\s]*\)\]\([^)\s]*\)|(?<!\[)!\[wbfy\]\(https://img\.shields\.io/badge/[^)\s]*\)(?!\])`,
  'gu'
);

// CommonMark's type-6 HTML block tags (https://spec.commonmark.org/0.31.2/#html-blocks), minus `h1`,
// which the badge anchor owns as the centered-title form. Listing only `div`/`table` let a `<section>`
// or `<article>` wrapper pass as ordinary Markdown, so the badge landed inside the raw block.
const htmlBlockPattern =
  /^ {0,3}<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h2|h3|h4|h5|h6|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?:[ \t>]|\/>|$)/iu;

interface MarkdownLine {
  content: string;
  end: number;
  ending: string;
  isProtected: boolean;
  /**
   * Whether the line is verbatim text (code, comment or front matter) rather than live markup. A raw
   * HTML block is protected but NOT raw text: its tags still open and close real HTML elements.
   */
  isRawText: boolean;
  spans: ProtectedSpan[];
}

interface ProtectedSpan {
  text: string;
  isProtected: boolean;
  /** Only set for protected spans; distinguishes an inline code span from an HTML comment. */
  kind?: 'code' | 'comment';
}

/** An inline code span or HTML comment left unterminated at a line ending, continuing on the next. */
interface OpenSpan {
  kind: 'code' | 'comment';
  /** Backtick run that must reappear to close the span; only set for code. */
  fence?: string;
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
  // A README whose title is `## Project` still deserves the badge under it, but a deeper heading is a
  // weaker candidate than a real `#` title later in the file, so it only serves as a fallback.
  let deeperHeadingEnd: number | undefined;

  for (let index = 0; index < analysis.lines.length; index++) {
    const line = analysis.lines[index]!;
    // Raw text (code, comments, front matter) holds no live tags; a raw HTML BLOCK does, and its
    // `<details>` must still be counted even though no badge may be inserted inside it.
    // Depth never goes negative: a stray `</details>` would otherwise bank a credit that cancels a
    // later real `<details>` and puts the badge under its hidden heading.
    if (!line.isRawText) collapsedDepth = nextDetailsDepth(visibleContentOf(line), collapsedDepth);
    if (line.isProtected || collapsedDepth > 0) continue;
    if (/^ {0,3}#(?:[ \t]+|$)/u.test(line.content)) return line.end;
    if (deeperHeadingEnd === undefined && /^ {0,3}#{2,6}(?:[ \t]+|$)/u.test(line.content)) deeperHeadingEnd = line.end;

    // A centered HTML title (`<h1 align="center">…</h1>`) is a title just as much as a Markdown
    // heading; without this the badge is inserted ABOVE it. The closing tag may sit on a later line.
    if (/^ {0,3}<h1(?:[ \t>]|$)/iu.test(line.content)) {
      for (let closingIndex = index; closingIndex < analysis.lines.length; closingIndex++) {
        const closingLine = analysis.lines[closingIndex]!;
        if (closingLine.isProtected) continue;
        // A `</h1>` written inside a comment or inline code closes nothing; anchoring there would put
        // the badge INSIDE the title and split the raw HTML block with blank lines.
        if (hasRawHtmlClosingTag(visibleContentOf(closingLine), 'h1')) return closingLine.end;
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
  return deeperHeadingEnd ?? analysis.frontMatterEnd;
}

/** The line's live Markdown, with its comment and inline-code spans removed. */
function visibleContentOf(line: MarkdownLine): string {
  if (line.spans.length === 0) return line.content;
  return line.spans
    .filter((span) => !span.isProtected)
    .map((span) => span.text)
    .join('');
}

function analyzeMarkdown(readme: string): MarkdownAnalysis {
  let openSpan: OpenSpan | undefined;
  let inHtmlBlock = false;
  let fence: { character: string; length: number; containerIndent: number } | undefined;
  let frontMatterMarker: string | undefined;
  let rawHtmlTag: string | undefined;
  let rawTextTerminator: string | undefined;
  // The container a block state was opened in. CommonMark ends an HTML block at the end of its
  // containing block quote or list item too, so a quoted block must not protect later top-level
  // lines — an unterminated `> <div>` used to hide the real title from the badge anchor.
  let blockContainerIndent = 0;
  let frontMatterEnd: number | undefined;
  let offset = 0;
  const lines: MarkdownLine[] = [];

  const rawLines = [...readme.matchAll(/.*?(?:\r\n|\n|$)/gu)].map((match) => match[0]).filter(Boolean);
  for (const [lineIndex, fullLine] of rawLines.entries()) {
    const ending = fullLine.match(/\r?\n$/u)?.[0] ?? '';
    const content = fullLine.slice(0, fullLine.length - ending.length);
    const trimmedLine = content.trim();
    const start = offset;
    const end = start + content.length;
    offset += fullLine.length;
    // A code span may continue onto later lines but never out of its own block, so an unmatched
    // backtick is only a span opener when its closer appears in the rest of THIS paragraph. A
    // heading's inline content ends with its own line, so it never looks ahead at all. The rest is
    // gathered LAZILY: scanning ahead from every line made analysis quadratic (6000 lines took 1.6s).
    let cachedParagraphRest: string | undefined;
    const getParagraphRest = (): string =>
      (cachedParagraphRest ??= isAtxHeading(content)
        ? ''
        : takeParagraphRest(rawLines, lineIndex + 1, content.length - getContainerContent(content).length));

    if (start === 0 && (trimmedLine === '---' || trimmedLine === '+++') && hasFrontMatterEnd(readme, trimmedLine)) {
      frontMatterMarker = trimmedLine;
      lines.push({ content, end, ending, isProtected: true, isRawText: true, spans: [] });
      continue;
    }
    if (frontMatterMarker) {
      if (trimmedLine === frontMatterMarker) {
        frontMatterMarker = undefined;
        frontMatterEnd = end;
      }
      lines.push({ content, end, ending, isProtected: true, isRawText: true, spans: [] });
      continue;
    }

    // Neither an inline code span nor a mid-line comment can contain a blank line (it would end the
    // paragraph), so one closes any span still open — otherwise a stray backtick or `<!--` would
    // silence badge removal for the rest of the file. A LINE-LEADING comment is a type-2 HTML block
    // instead, tracked by rawTextTerminator, and it may legitimately span blank lines.
    if (openSpan && !trimmedLine) openSpan = undefined;

    // A line outside the container that opened the block ends it, whatever its own terminator says.
    if ((rawTextTerminator || rawHtmlTag || inHtmlBlock) && exitsContainer(content, blockContainerIndent)) {
      rawTextTerminator = undefined;
      rawHtmlTag = undefined;
      inHtmlBlock = false;
    }

    // Types 1 and 3-5 hold VERBATIM text and each run to their own terminator.
    if (rawTextTerminator) {
      if (content.includes(rawTextTerminator)) rawTextTerminator = undefined;
      lines.push({ content, end, ending, isProtected: true, isRawText: true, spans: [] });
      continue;
    }

    // Any of the four type-1 tags closes the block, not just the one that opened it: CommonMark's
    // end condition names the whole set, so `<pre>` followed by `</script>` ends there.
    if (rawHtmlTag) {
      if (hasVerbatimHtmlClosingTag(content)) rawHtmlTag = undefined;
      lines.push({ content, end, ending, isProtected: true, isRawText: true, spans: [] });
      continue;
    }

    // A CommonMark type-6 HTML block ends at a BLANK LINE, not at a closing tag, and that blank line
    // sits outside the block. Waiting for the closing tag instead left an unclosed block open to the
    // end of the file, hiding the real title from the badge anchor. Its spans are still computed: the
    // block holds live markup, so a `<details>` commented out inside it must not count as an opener.
    if (inHtmlBlock) {
      if (!trimmedLine) inHtmlBlock = false;
      // Attribute values are blanked first: a `<!--` written inside one is not a comment opener, and
      // treating it as one protected the rest of the README and stranded the badge above the title.
      const split = splitProtectedSpans(stripAttributeValues(content), openSpan, getParagraphRest);
      openSpan = split.openSpan;
      lines.push({ content, end, ending, isProtected: !!trimmedLine, isRawText: false, spans: split.spans });
      continue;
    }

    // A span left open on the previous line keeps running here, so this line is split against that
    // state rather than read as fresh Markdown. Only the part up to the closing delimiter stays
    // protected: text after a `-->` is live Markdown, and a badge there must still be superseded.
    if (openSpan) {
      const split = splitProtectedSpans(content, openSpan, getParagraphRest);
      openSpan = split.openSpan;
      lines.push(buildSpanLine(content, end, ending, split.spans));
      continue;
    }

    if (fence) {
      // An unclosed fence ends with the list item or block quote that opened it, so a line that falls
      // outside that container closes it — otherwise the rest of the file stays code and the real
      // title never anchors.
      if (trimmedLine && leadingWhitespaceOf(content) < fence.containerIndent && !isContainerStart(content)) {
        fence = undefined;
      } else {
        const fenceMatch = getContainerContent(content).match(/^ {0,3}(`+|~+)[ \t]*$/u)?.[1];
        if (fenceMatch?.[0] === fence.character && fenceMatch.length >= fence.length) fence = undefined;
        lines.push({ content, end, ending, isProtected: true, isRawText: true, spans: [] });
        continue;
      }
    }

    const openingFenceMatch = getContainerContent(content).match(/^ {0,3}(`{3,}|~{3,})(.*)$/u);
    const fenceMatch = openingFenceMatch?.[1];
    const fenceInfo = openingFenceMatch?.[2] ?? '';
    if (fenceMatch && (fenceMatch[0] === '~' || !fenceInfo.includes('`'))) {
      fence = {
        character: fenceMatch[0]!,
        length: fenceMatch.length,
        containerIndent: content.length - getContainerContent(content).length,
      };
      lines.push({ content, end, ending, isProtected: true, isRawText: true, spans: [] });
      continue;
    }

    // A type-1 block holds VERBATIM text and runs to its closing tag; a type-6 block holds markup and
    // runs to a blank line. `h1` is deliberately absent from both: the badge anchor treats a centered
    // `<h1>` as the title, which protecting it would hide.
    // Matched against the CONTAINER CONTENT: a `> <pre>` example inside a block quote is a raw
    // block just as much as an unquoted one, and reading the raw line missed it and deleted its
    // badge example.
    const containerContent = getContainerContent(content);
    const verbatimHtmlTag = containerContent.match(/^ {0,3}<(pre|script|style|textarea)(?:[ \t>]|$)/iu)?.[1];
    if (verbatimHtmlTag) {
      if (!hasVerbatimHtmlClosingTag(content.slice(content.indexOf('<') + 1))) {
        rawHtmlTag = verbatimHtmlTag;
        blockContainerIndent = content.length - containerContent.length;
      }
      lines.push({ content, end, ending, isProtected: true, isRawText: true, spans: [] });
      continue;
    }
    // CommonMark HTML block types 3-5: a processing instruction, a declaration and a CDATA section.
    // Each holds verbatim text that the badge must not be inserted into.
    const rawTextOpener = RAW_TEXT_BLOCKS.find(([opener]) =>
      new RegExp(`^ {0,3}${opener}`, 'u').test(containerContent)
    );
    if (rawTextOpener) {
      const [, terminator] = rawTextOpener;
      if (!containerContent.slice(containerContent.indexOf('<')).includes(terminator)) {
        rawTextTerminator = terminator;
        blockContainerIndent = content.length - containerContent.length;
      }
      lines.push({ content, end, ending, isProtected: true, isRawText: true, spans: [] });
      continue;
    }
    if (htmlBlockPattern.test(containerContent)) {
      inHtmlBlock = true;
      blockContainerIndent = content.length - containerContent.length;
      const split = splitProtectedSpans(stripAttributeValues(content), undefined, getParagraphRest);
      openSpan = split.openSpan;
      lines.push({ content, end, ending, isProtected: true, isRawText: false, spans: split.spans });
      continue;
    }

    const split = splitProtectedSpans(content, undefined, getParagraphRest);
    openSpan = split.openSpan;
    const line = buildSpanLine(content, end, ending, split.spans);
    // Measured after the container prefix: `>     example` is an indented code block just like an
    // unquoted one, and reading the raw line deleted its badge example as if it were live.
    lines.push(isIndentedCode(containerContent) ? { ...line, isProtected: true, isRawText: true, spans: [] } : line);
  }
  return { frontMatterEnd, lines };
}

/** CommonMark HTML block types 3-5, as `[opening pattern, terminator]` pairs. */
const RAW_TEXT_BLOCKS: [string, string][] = [
  // A comment that BEGINS a line is a type-2 HTML block whose last line runs through `-->` in full,
  // so badge-shaped text after the terminator is raw block content, not live Markdown. A comment
  // opening mid-line is an ordinary inline span instead, and text after its `-->` stays live.
  ['<!--', '-->'],
  [String.raw`<!\[CDATA\[`, ']]>'],
  [String.raw`<\?`, '?>'],
  [String.raw`<![A-Za-z]`, '>'],
];

/**
 * The lines following `from` that belong to the same paragraph. CommonMark settles block structure
 * before inline spans, so the paragraph ends at a blank line — including one that is blank inside its
 * container, like a lone `>` — and at a heading, which starts a block of its own.
 */
function takeParagraphRest(rawLines: string[], from: number, containerIndent: number): string {
  const rest: string[] = [];
  for (let index = from; index < rawLines.length; index++) {
    const line = rawLines[index]!;
    // Leaving the opener's container ends the paragraph just as entering a new one does: a backtick
    // opened inside a block quote must not pair with a later top-level one across the boundary.
    if (line.length - getContainerContent(line).length !== containerIndent) break;
    if (!getContainerContent(line).trim() || isParagraphInterrupter(line)) break;
    rest.push(line);
  }
  return rest.join('');
}

function isAtxHeading(content: string): boolean {
  return /^ {0,3}#{1,6}(?:[ \t]|$)/u.test(content);
}

/**
 * Whether the line starts a block of its own rather than continuing the paragraph above. CommonMark
 * settles block structure before inline spans, so a code span must not reach across one of these.
 */
function isParagraphInterrupter(content: string): boolean {
  return (
    isAtxHeading(content) ||
    isContainerStart(content) ||
    htmlBlockPattern.test(content) ||
    /^ {0,3}(?:`{3,}|~{3,})/u.test(content) ||
    /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/u.test(content) ||
    /^ {0,3}<(?:pre|script|style|textarea|!|\?)/iu.test(content)
  );
}

/** Whether the line sits outside a container whose content started at `containerIndent`. */
function exitsContainer(content: string, containerIndent: number): boolean {
  if (containerIndent === 0 || !content.trim()) return false;
  return leadingWhitespaceOf(content) < containerIndent && !isContainerStart(content);
}

function leadingWhitespaceOf(content: string): number {
  return content.length - content.trimStart().length;
}

function isContainerStart(content: string): boolean {
  return content !== getContainerContent(content);
}

function buildSpanLine(content: string, end: number, ending: string, spans: ProtectedSpan[]): MarkdownLine {
  // A line made up entirely of comment or code spans is verbatim text: a heading inside it is not a
  // title, and a badge example inside it must survive.
  const isProtected = spans.length > 0 && spans.every((span) => span.isProtected);
  return { content, end, ending, isProtected, isRawText: isProtected, spans };
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
      const content = line.spans
        .map((segment) =>
          segment.isProtected
            ? segment.text
            : // A backslash-escaped `[` or `!` makes the badge literal documentation rather than a
              // managed badge, so an escaped example must survive instead of being deleted.
              segment.text.replaceAll(pattern, (match, offset: number) =>
                isEscaped(segment.text, offset) ? match : ''
              )
        )
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
 * inline code) segments, continuing any span `openSpan` left open on the previous line and reporting
 * whichever span this line leaves open in turn.
 */
function splitProtectedSpans(
  content: string,
  openSpan: OpenSpan | undefined,
  getParagraphRest: () => string
): { spans: ProtectedSpan[]; openSpan: OpenSpan | undefined } {
  const spans: ProtectedSpan[] = [];
  let plainStart = 0;
  let index = 0;
  const pushSpan = (end: number, kind: 'code' | 'comment'): void => {
    if (plainStart < index) spans.push({ text: content.slice(plainStart, index), isProtected: false });
    spans.push({ text: content.slice(index, end), isProtected: true, kind });
    plainStart = end;
    index = end;
  };

  if (openSpan) {
    const spanEnd =
      openSpan.kind === 'comment'
        ? content.includes('-->')
          ? content.indexOf('-->') + 3
          : undefined
        : findCodeEnd(content, openSpan.fence!, 0);
    if (spanEnd === undefined) {
      return { spans: [{ text: content, isProtected: true, kind: openSpan.kind }], openSpan };
    }
    spans.push({ text: content.slice(0, spanEnd), isProtected: true, kind: openSpan.kind });
    plainStart = spanEnd;
    index = spanEnd;
  }

  let carried: OpenSpan | undefined;
  while (index < content.length) {
    // A backslash escape covers the next character, so `` \` `` is literal text and opens nothing.
    if (content[index] === '\\') {
      index += 2;
      continue;
    }
    if (content.startsWith('<!--', index)) {
      const commentEnd = content.indexOf('-->', index + 4);
      if (commentEnd === -1) {
        // A comment opening MID-LINE is inline HTML, so like a code span it lives inside one
        // paragraph. Carrying it regardless made an unterminated opener protect the rest of the
        // file, leaving a stale badge below it live but untouched — and so duplicated.
        if (!getParagraphRest().includes('-->')) {
          index += 4;
          continue;
        }
        pushSpan(content.length, 'comment');
        carried = { kind: 'comment' };
        break;
      }
      pushSpan(commentEnd + 3, 'comment');
      continue;
    }
    if (content[index] === '`') {
      const fence = /^`+/u.exec(content.slice(index))![0];
      const codeEnd = findCodeEnd(content, fence, index + fence.length);
      if (codeEnd !== undefined) {
        pushSpan(codeEnd, 'code');
        continue;
      }
      // A code span may continue onto later lines, but only when its closer actually appears in the
      // rest of the paragraph. Without that check a lone stray backtick protected everything after
      // it, so a stale badge below was never superseded and got duplicated instead.
      if (findCodeEnd(getParagraphRest(), fence, 0) === undefined) {
        index += fence.length;
        continue;
      }
      pushSpan(content.length, 'code');
      carried = { kind: 'code', fence };
      break;
    }
    index++;
  }
  if (plainStart < content.length) spans.push({ text: content.slice(plainStart), isProtected: false });
  return { spans, openSpan: carried };
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
  // The space after a block-quote `>` is optional in CommonMark, so `>```md` opens a fence just as
  // `> ```md` does; requiring it made the compact form's fenced example look like ordinary Markdown
  // and its badge example was deleted as if it were live.
  return line.replace(/^ {0,3}(?:>[ \t]?|(?:[-+*]|\d{1,9}[.)])[ \t]+)+/u, '');
}

/** The offset just past the run of `fence` backticks that closes a code span, if there is one. */
function findCodeEnd(within: string, fence: string, from: number): number | undefined {
  // Only a run of exactly the same length closes the span, so a longer run is skipped over.
  const closing = new RegExp('(?<!`)`{' + fence.length + '}(?!`)', 'u').exec(within.slice(from));
  return closing ? from + closing.index + fence.length : undefined;
}

/** Whether the character at `offset` is escaped by an odd-length run of backslashes before it. */
function isEscaped(text: string, offset: number): boolean {
  let backslashes = 0;
  while (offset - backslashes > 0 && text[offset - backslashes - 1] === '\\') backslashes++;
  return backslashes % 2 === 1;
}

/** Whether the line closes a CommonMark type-1 HTML block, whichever of its tags opened it. */
function hasVerbatimHtmlClosingTag(line: string): boolean {
  return /<\/(?:pre|script|style|textarea)[ \t]*>/iu.test(stripAttributeValues(line));
}

function hasRawHtmlClosingTag(line: string, tag: string): boolean {
  return new RegExp(`</${tag}[ \\t]*>`, 'iu').test(stripAttributeValues(line));
}

/**
 * The `<details>` nesting depth after the line, scanning its opening and closing tags in order. Quoted attribute values are blanked and backslash-escaped `<` is skipped, since neither
 * one is a tag — counting them let a literal `\<details>` or a `</details>` written in an attribute
 * hide the real title from the badge anchor.
 */
function nextDetailsDepth(line: string, depth: number): number {
  const stripped = stripAttributeValues(line);
  for (const match of stripped.matchAll(/<(\/?)details(?:[ \t>]|$)/giu)) {
    if (isEscaped(stripped, match.index)) continue;
    // Clamped per TAG, not per line: on `</details><details>` a net delta of zero would cancel the
    // real opener against a stray closer and put the badge under the heading it hides.
    depth = match[1] ? Math.max(0, depth - 1) : depth + 1;
  }
  return depth;
}

/**
 * Blanks out quoted attribute values inside tags, so `<h1 title="literal </h1> text">` no longer
 * looks like it closes the title and splits the element in half.
 */
function stripAttributeValues(line: string): string {
  // The tag pattern steps OVER quoted values rather than stopping at the first `>`, which may sit
  // inside one of them.
  return line.replaceAll(/<[^>"']*(?:(?:"[^"]*"|'[^']*')[^>"']*)*>/gu, (tag) =>
    tag.replaceAll(/"[^"]*"|'[^']*'/gu, (value) => '_'.repeat(value.length))
  );
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
      // GitHub's UI hands out badge URLs carrying `?branch=…`/`?event=…`, so the query string is
      // optional on both URLs; without it such a badge survived removal and was duplicated.
      String.raw`\[!\[${escapedBadgeName}\]\(https://github\.com/[^/\s)]+/[^/\s)]+/actions/workflows/${escapedFileName}/badge\.svg(?:\?[^)\s]*)?\)\]\(https://github\.com/[^/\s)]+/[^/\s)]+/actions/workflows/${escapedFileName}(?:\?[^)\s]*)?\)`,
      'gu'
    )
  );
}

function escapeRegExp(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}
