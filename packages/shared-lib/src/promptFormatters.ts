import { escapePromptTag } from './prompt.js';
import { toCodeBlock } from './text.js';

/**
 * Renders files as Markdown sections for an LLM prompt: a heading holding the path, followed by the file contents in a
 * code block whose fence the contents cannot close. Line endings are normalized to LF and trailing whitespace is removed.
 * The output reads back with `extractSections` (keyed by path) and `extractIfSingleOutermostCodeBlock`, so an
 * LLM can be asked to answer in the same format.
 */
export function formatFilesForPrompt(files: readonly { path: string; data: string }[], headingLevel = 1): string {
  const headingMarker = '#'.repeat(headingLevel);
  return files
    .map((file) => `${headingMarker} ${file.path}\n\n${toCodeBlock(file.data.replaceAll(/\r\n?/gu, '\n').trimEnd())}`)
    .join('\n\n');
}

/**
 * Renders chat messages as `<role>` elements separated by blank lines, e.g. to embed a conversation log in a prompt.
 * Every role's tag is escaped in every message, so a message cannot close its element and pose as another role.
 * To wrap the result in another element, escape that tag in the result with `escapePromptTag`.
 */
export function formatMessagesForPrompt(messages: readonly { role: string; content: string }[]): string {
  const roles = [...new Set(messages.map((message) => message.role))];
  return messages
    .map((message) => {
      let content = message.content;
      for (const role of roles) content = escapePromptTag(content, role);
      return `<${message.role}>\n${content}\n</${message.role}>`;
    })
    .join('\n\n');
}
