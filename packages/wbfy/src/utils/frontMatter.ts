const frontMatterPattern = /^---[ \t]*\r?\n([\s\S]*?)^---[ \t]*(?:\r?\n|$)/mu;

/** The front matter that opens `text`, which must not start with a byte order mark. */
export function matchFrontMatter(text: string): { block: string; body: string } | undefined {
  const match = text.startsWith('---') ? frontMatterPattern.exec(text) : undefined;
  return match?.index === 0 ? { block: match[0], body: match[1] ?? '' } : undefined;
}
