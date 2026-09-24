import { fileURLToPath } from 'node:url';

import type { Node } from 'web-tree-sitter';
import { Language, Parser } from 'web-tree-sitter';

let parserPromise: Promise<Parser> | undefined;

/**
 * Returns the unquoted words (command name first) of every simple command in a Bash script, including those nested
 * in subshells, compound statements, and command substitutions, or undefined when the script does not parse.
 * Heredoc bodies and comments are not commands, so they never contribute words.
 */
export async function parseShellCommands(script: string): Promise<string[][] | undefined> {
  parserPromise ??= createParser();
  const parser = await parserPromise;
  const tree = parser.parse(script);
  if (!tree) return;
  try {
    if (tree.rootNode.hasError) return;
    return tree.rootNode.descendantsOfType('command').flatMap((command) => {
      const name = command?.childForFieldName('name');
      if (!command || !name) return [];
      return [[name, ...command.childrenForFieldName('argument')].map((word) => unquoteWord(word))];
    });
  } finally {
    tree.delete();
  }
}

async function createParser(): Promise<Parser> {
  await Parser.init();
  const parser = new Parser();
  parser.setLanguage(await Language.load(fileURLToPath(import.meta.resolve('tree-sitter-bash/tree-sitter-bash.wasm'))));
  return parser;
}

function unquoteWord(node: Node): string {
  switch (node.type) {
    case 'command_name': {
      return node.firstChild ? unquoteWord(node.firstChild) : node.text;
    }
    case 'concatenation': {
      return node.children.map((child) => unquoteWord(child)).join('');
    }
    case 'raw_string': {
      return node.text.slice(1, -1);
    }
    case 'string': {
      return node.text
        .slice(1, -1)
        .replaceAll('\\\n', '')
        .replaceAll(/\\([$`"\\])/gu, '$1');
    }
    case 'word': {
      return node.text.replaceAll('\\\n', '').replaceAll(/\\(.)/gsu, '$1');
    }
    default: {
      // Expansions and substitutions have no static value; their source text never equals a literal word.
      return node.text;
    }
  }
}
