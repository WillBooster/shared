import { escapePromptTag } from './prompt.js';
import { toCodeBlock } from './text.js';

/**
 * Renders files as Markdown sections for an LLM prompt: a heading holding the single-line path in inline code,
 * followed by the file contents in a code block whose fence the contents cannot close. Line endings are normalized
 * to LF and trailing whitespace is removed.
 * The output reads back with `extractSections` (keyed by path) and `extractIfSingleOutermostCodeBlock`, so an
 * LLM can be asked to answer in the same format.
 */
export function formatFilesForPrompt(files: readonly { path: string; data: string }[], headingLevel = 1): string {
  const headingMarker = '#'.repeat(headingLevel);
  return files
    .map(
      (file) =>
        `${headingMarker} ${formatPath(file.path)}\n\n${toCodeBlock(file.data.replaceAll(/\r\n?/gu, '\n').trimEnd())}`
    )
    .join('\n\n');
}

function formatPath(path: string): string {
  let length = 1;
  for (const match of path.matchAll(/`+/gu)) length = Math.max(length, match[0].length + 1);
  const delimiter = '`'.repeat(length);
  return `${delimiter} ${path} ${delimiter}`;
}

/**
 * Renders chat messages as `<role>` elements separated by blank lines, e.g. to embed a conversation log in a prompt.
 * Escapes system, developer, user, assistant, tool, and every supplied role's tags in message contents.
 * Roles must be trusted literal tag names supplied by the caller. This preserves delimiters, not instruction priority.
 * To wrap the result in another element, escape that tag in the result with `escapePromptTag`.
 */
export function formatMessagesForPrompt(messages: readonly { role: string; content: string }[]): string {
  const roles = [
    ...new Set(['system', 'developer', 'user', 'assistant', 'tool', ...messages.map((message) => message.role)]),
  ];
  return messages
    .map((message) => {
      let content = message.content;
      for (const role of roles) content = escapePromptTag(content, role);
      return `<${message.role}>\n${content}\n</${message.role}>`;
    })
    .join('\n\n');
}
