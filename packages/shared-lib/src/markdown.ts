export interface CodeBlock {
  /** The first word of the info string, lowercased; `undefined` when the fence has none. */
  language?: string;
  code: string;
  /** `false` when the text ends before the closing fence, e.g. because the LLM output was cut off. */
  isClosed: boolean;
}

interface Fence {
  char: string;
  length: number;
  indent: number;
  language: string;
}

/**
 * Extracts the fenced code blocks (backticks or tildes, any fence length) of Markdown text such as an LLM response.
 * A block runs to the first closing fence of the same character that is at least as long as its opening fence,
 * so a longer fence can hold shorter fences. Only fences indented by at most three spaces are recognized; fences
 * inside block quotes, deeply nested list items, and indented code blocks are not.
 */
export function extractCodeBlocks(markdown: string): CodeBlock[] {
  const lines = splitLines(markdown);
  const blocks: CodeBlock[] = [];
  for (let index = 0; index < lines.length; index++) {
    const fence = parseOpeningFence(lines[index] ?? '');
    if (!fence) continue;
    const end = findClosingFence(lines, index + 1, fence);
    blocks.push({
      ...(fence.language && { language: fence.language }),
      code: lines
        .slice(index + 1, end)
        .map((line) => stripIndent(line, fence.indent))
        .join('\n'),
      isClosed: end < lines.length,
    });
    index = end;
  }
  return blocks;
}

/**
 * Returns the contents of the code block that an LLM wrapped its whole response in, or `text` itself when the
 * response does not start with a fence or the fence's language is not one of `languages` (compared case-insensitively).
 * When the response also ends with a matching closing fence, everything between its first and last lines is returned,
 * so fences the LLM nested without lengthening the outer fence stay in the contents. Otherwise the first block is
 * returned and text after it is dropped; an unclosed block runs to the end of the text.
 */
export function extractIfSingleOutermostCodeBlock(text: string, languages?: readonly string[]): string {
  const block = findOutermostCodeBlock(text);
  if (!block) return text;
  if (languages?.length && !languages.some((language) => language.toLowerCase() === block.language)) return text;
  return block.code;
}

const WRAPPED_MARKDOWN_LANGUAGES = new Set(['', 'markdown', 'md']);

/**
 * Splits Markdown text such as an LLM response into sections at its shallowest ATX heading level, mapping each
 * heading's text (with inline-code backticks removed) to the source text under it, trimmed. Sections without
 * content are omitted, and a later duplicate heading overwrites an earlier one.
 * Only headings starting at the beginning of a line outside fenced code blocks count; setext headings (underlined
 * with `=` or `-`) are ignored. When the whole text is wrapped in a `markdown`, `md`, or unlabeled code block, as
 * `extractIfSingleOutermostCodeBlock` finds it (so fences nested inside stay in the contents), the headings inside
 * that block are used if there are any.
 */
export function extractTopLevelHeadings(markdown: string): Record<string, string> {
  const block = findOutermostCodeBlock(markdown);
  if (block?.isWhole && WRAPPED_MARKDOWN_LANGUAGES.has(block.language)) {
    const headingToContent = splitByTopLevelHeadings(block.code);
    if (Object.keys(headingToContent).length > 0) return headingToContent;
  }
  return splitByTopLevelHeadings(markdown);
}

function splitByTopLevelHeadings(markdown: string): Record<string, string> {
  const lines = splitLines(markdown);
  const headings = findHeadings(lines);
  if (headings.length === 0) return {};

  const minDepth = Math.min(...headings.map((heading) => heading.depth));
  const topLevelHeadings = headings.filter((heading) => heading.depth === minDepth);
  const headingToContent: Record<string, string> = {};
  for (const [index, heading] of topLevelHeadings.entries()) {
    const content = lines
      .slice(heading.index + 1, topLevelHeadings[index + 1]?.index)
      .join('\n')
      .trim();
    if (content) headingToContent[heading.text] = content;
  }
  return headingToContent;
}

function findOutermostCodeBlock(text: string): { language: string; code: string; isWhole: boolean } | undefined {
  // Keep the opening fence's indentation, which is stripped from the contents.
  const lines = splitLines(text.replace(/^\s*\n/u, '').trimEnd());
  const fence = parseOpeningFence(lines[0] ?? '');
  if (!fence) return;
  const lastIndex = lines.length - 1;
  const end =
    lastIndex > 0 && isClosingFence(lines[lastIndex] ?? '', fence) ? lastIndex : findClosingFence(lines, 1, fence);
  return {
    language: fence.language,
    code: lines
      .slice(1, end)
      .map((line) => stripIndent(line, fence.indent))
      .join('\n'),
    isWhole: end >= lastIndex,
  };
}

function findHeadings(lines: readonly string[]): { index: number; depth: number; text: string }[] {
  const headings: { index: number; depth: number; text: string }[] = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? '';
    const fence = parseOpeningFence(line);
    if (fence) {
      index = findClosingFence(lines, index + 1, fence);
      continue;
    }
    const match = /^(#{1,6})(?:[ \t]+(.*))?$/u.exec(line);
    if (!match) continue;
    const text = (match[2] ?? '')
      // The closing sequence of an ATX heading needs a space before it, so `# C#` keeps its `#`.
      .replace(/(?:^|[ \t]+)#+[ \t]*$/u, '')
      .replaceAll(/(`+)(.+?)\1/gu, '$2')
      .trim();
    headings.push({ index, depth: match[1]?.length ?? 1, text });
  }
  return headings;
}

function parseOpeningFence(line: string): Fence | undefined {
  const match = /^( {0,3})(`{3,}|~{3,})(.*)$/u.exec(line);
  const fence = match?.[2];
  const info = match?.[3] ?? '';
  // A backtick in the info string makes the line inline code instead of a fence.
  if (!fence || (fence.startsWith('`') && info.includes('`'))) return;
  return {
    char: fence.charAt(0),
    length: fence.length,
    indent: match[1]?.length ?? 0,
    language: info.trim().split(/\s/u)[0]?.toLowerCase() ?? '',
  };
}

/** Returns the index of the line closing `fence`, or the number of lines when it is never closed. */
function findClosingFence(lines: readonly string[], start: number, fence: Fence): number {
  let index = start;
  while (index < lines.length && !isClosingFence(lines[index] ?? '', fence)) index++;
  return index;
}

function isClosingFence(line: string, fence: Fence): boolean {
  const closer = /^ {0,3}(`{3,}|~{3,})[ \t]*$/u.exec(line)?.[1];
  return closer?.charAt(0) === fence.char && closer.length >= fence.length;
}

function stripIndent(line: string, indent: number): string {
  let index = 0;
  while (index < indent && line[index] === ' ') index++;
  return line.slice(index);
}

function splitLines(text: string): string[] {
  return text.split(/\r?\n/u);
}
