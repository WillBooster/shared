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
 * response does not start with a fence or the fence's language is not one of a nonempty `languages` list
 * (compared case-insensitively). An omitted or empty list allows any language.
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
 * Returns the trimmed contents of the first closed fenced code block (backticks or tildes) that follows a line holding
 * only `<tagName>` in text such as an LLM response, e.g. `<answer>\n~~~\n42\n~~~`, or `undefined` when there is none.
 * Only blank lines may separate the tag line from the opening fence. Mentions of the tag within prose lines and tag
 * lines inside other fenced blocks (e.g. a format example) are skipped, but a whole-response `markdown`, `md`, or
 * unlabeled wrapper is read inside, as `parseMarkdownSections` does.
 */
export function extractTaggedCodeBlock(text: string, tagName: string): string | undefined {
  const tag = `<${tagName}>`;
  const wrapper = findOutermostCodeBlock(text);
  // A leading example block and the tagged block can look like a whole-response wrapper, so fall back to the text.
  const wrapped =
    wrapper?.isWhole && WRAPPED_MARKDOWN_LANGUAGES.has(wrapper.language)
      ? findTaggedCodeBlock(splitLines(wrapper.code), tag)
      : undefined;
  return wrapped ?? findTaggedCodeBlock(splitLines(text), tag);
}

function findTaggedCodeBlock(lines: readonly string[], tag: string): string | undefined {
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? '';
    const enclosingFence = parseOpeningFence(line);
    if (enclosingFence) {
      index = findClosingFence(lines, index + 1, enclosingFence);
      continue;
    }
    if (line.trim() !== tag) continue;
    let fenceIndex = index + 1;
    while (fenceIndex < lines.length && !lines[fenceIndex]?.trim()) fenceIndex++;
    const fence = parseOpeningFence(lines[fenceIndex] ?? '');
    if (!fence) continue;
    const end = findClosingFence(lines, fenceIndex + 1, fence);
    if (end < lines.length) {
      return lines
        .slice(fenceIndex + 1, end)
        .map((contentLine) => stripIndent(contentLine, fence.indent))
        .join('\n')
        .trim();
    }
  }
}

export interface MarkdownSection {
  depth: number;
  /** The heading text with the closing `#` sequence and inline-code backticks removed. */
  heading: string;
  /** The source text up to the next heading at the same or a shallower depth, trimmed; subsections are included. */
  content: string;
}

/**
 * Extracts the content of the section headed by each of `names` from Markdown text such as an LLM response, keyed by
 * the given names. A heading matches a name when both are equal after removing decorations at their edges (such as
 * `**bold**`, backticks, and quotes), a leading number like `1.` or `2.1`, and a trailing colon, ignoring case and spacing;
 * headings at any depth are candidates.
 * Among matching headings, the shallowest wins, then one equal to the name as written, then the first; each heading
 * serves at most one name. When distinct requested names normalize alike, only exact matches at the shallowest
 * matching depth are returned. Missing, empty, or ambiguous sections are absent from the prototype-free result.
 */
export function extractSections<const Name extends string>(
  markdown: string,
  names: readonly Name[]
): Partial<Record<Name, string>> {
  const candidates = parseMarkdownSections(markdown).map((section) => ({
    ...section,
    key: normalizeHeading(section.heading),
  }));
  const requested = [...new Set(names)].map((name) => ({ name, key: normalizeHeading(name) }));
  const sections: Partial<Record<Name, string>> = Object.create(null);
  for (const { name, key } of requested) {
    let best: (typeof candidates)[number] | undefined;
    for (const candidate of candidates) {
      if (candidate.key !== key) continue;
      if (
        !best ||
        candidate.depth < best.depth ||
        (candidate.depth === best.depth && candidate.heading === name && best.heading !== name)
      ) {
        best = candidate;
      }
    }
    if (!best) continue;
    if (best.heading !== name && requested.some((other) => other.name !== name && other.key === key)) continue;
    if (best.content) sections[name] = best.content;
  }
  return sections;
}

/**
 * Returns every ATX heading of Markdown text in order, with the source text under it.
 * Only headings starting at the beginning of a line outside fenced code blocks count; setext headings (underlined
 * with `=` or `-`) are ignored. A whole-response `markdown`, `md`, or unlabeled wrapper is read inside as
 * `extractIfSingleOutermostCodeBlock` finds it, preserving nested fences. A leading wrapper followed by prose is
 * also read inside, but only when there are no headings outside fences.
 */
export function parseMarkdownSections(markdown: string): MarkdownSection[] {
  const block = findOutermostCodeBlock(markdown);
  const wrapper = block && WRAPPED_MARKDOWN_LANGUAGES.has(block.language) ? block : undefined;
  if (wrapper?.isWhole) return splitSections(wrapper.code);
  const sections = splitSections(markdown);
  return sections.length === 0 && wrapper ? splitSections(wrapper.code) : sections;
}

function normalizeHeading(heading: string): string {
  return stripHeadingEdges(stripHeadingEdges(heading).replace(/^\d+(?:\.\d+)*(?:\.\s+|\)\s*|\s+)/u, ''))
    .replaceAll(/\s+/gu, ' ')
    .toLowerCase();
}

function stripHeadingEdges(text: string): string {
  // Only the edges: `_` and `*` inside a heading belong to names such as `my_file.py`.
  return text.replaceAll(/^[\s*_`~"'「」]+|[\s*_`~"'「」:：]+$/gu, '');
}

function splitSections(markdown: string): MarkdownSection[] {
  const lines = splitLines(markdown);
  const headings = findHeadings(lines);
  return headings.map((heading, index) => {
    let nextIndex = index + 1;
    while (nextIndex < headings.length && (headings[nextIndex]?.depth ?? 0) > heading.depth) nextIndex++;
    return {
      depth: heading.depth,
      heading: heading.text,
      content: lines
        .slice(heading.index + 1, headings[nextIndex]?.index)
        .join('\n')
        .trim(),
    };
  });
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
      .trim()
      .replaceAll(/(`+)(.+?)\1/gu, (_match, _delimiter: string, content: string) =>
        content.startsWith(' ') && content.endsWith(' ') ? content.slice(1, -1) : content
      );
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
