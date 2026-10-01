import path from 'node:path';

import { Language, type Node, Parser } from 'web-tree-sitter';

import { getWbfyDirPath } from './version.js';

// wbfy must resolve before it refreshes global release-age exclusions. Ship the Bash grammar
// with the package so a newly published grammar release cannot block that first installation.
await Parser.init();
const parser = new Parser();
parser.setLanguage(await Language.load(path.join(getWbfyDirPath(), 'configs', 'tree-sitter-bash.wasm')));

/**
 * Returns the unquoted words (command name first) of every simple command in a Bash script, including those nested
 * in subshells, compound statements, and command substitutions, or undefined when the script does not parse.
 * Comments and literal heredoc text are not commands (command substitutions in an unquoted heredoc are), and function
 * bodies are skipped because they run only when called.
 */
export function parseShellCommands(script: string): string[][] | undefined {
  const rootNode = parser.parse(script)?.rootNode;
  if (!rootNode || rootNode.hasError) return;
  return rootNode.descendantsOfType('command').flatMap((command) => {
    const name = command.childForFieldName('name');
    if (!name || isInFunctionBody(command)) return [];
    return [[name, ...command.childrenForFieldName('argument')].map((word) => unquoteWord(word))];
  });
}

function isInFunctionBody(node: Node): boolean {
  for (let ancestor = node.parent; ancestor; ancestor = ancestor.parent) {
    if (ancestor.type === 'function_definition') return true;
  }
  return false;
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
