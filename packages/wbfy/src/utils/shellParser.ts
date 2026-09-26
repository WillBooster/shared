import Bash from '@willbooster/tree-sitter-bash';
import Parser from 'tree-sitter';

type Node = Parser.SyntaxNode;

let parser: Parser | undefined;

/**
 * Returns the unquoted words (command name first) of every simple command in a Bash script, including those nested
 * in subshells, compound statements, and command substitutions, or undefined when the script does not parse.
 * Comments and literal heredoc text are not commands (command substitutions in an unquoted heredoc are), and function
 * bodies are skipped because they run only when called.
 */
export function parseShellCommands(script: string): string[][] | undefined {
  parser ??= createParser();
  const { rootNode } = parser.parse(script);
  if (rootNode.hasError) return;
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

function createParser(): Parser {
  const parser = new Parser();
  parser.setLanguage(Bash as Parser.Language);
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
