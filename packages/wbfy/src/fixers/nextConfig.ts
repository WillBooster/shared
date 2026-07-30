import fs from 'node:fs';
import path from 'node:path';

import * as ast from 'typescript/unstable/ast';

import { logger } from '../logger.js';
import type { PackageConfig } from '../packageConfig.js';
import { fsUtil } from '../utils/fsUtil.js';
import { promisePool } from '../utils/promisePool.js';
import { parseSourceFile } from '../utils/typescriptApi.js';

// Settings every WillBooster Next.js project should carry. `name` is the top-level
// property key used to detect whether the setting already exists; `text` is inserted
// verbatim (a whole `key: value` pair) when the key is missing.
const managedProperties: readonly { name: string; text: string }[] = [
  { name: 'reactCompiler', text: 'reactCompiler: true' },
  { name: 'reactStrictMode', text: 'reactStrictMode: true' },
  { name: 'typescript', text: 'typescript: { ignoreBuildErrors: true }' },
];

export async function fixNextConfigJson(config: PackageConfig): Promise<void> {
  return logger.functionIgnoringException('fixNextConfigJson', async () => {
    const filePath = ['ts', 'mts', 'cts', 'js', 'mjs', 'cjs']
      .map((ext) => path.resolve(config.dirPath, `next.config.${ext}`))
      .find((p) => fs.existsSync(p));
    if (!filePath) return;

    const extracted = getNextConfigObjectLiteral(filePath);
    if (!extracted) return;
    const { source, objectLiteral } = extracted;

    // `properties` includes spread assignments (`...rest`) that carry no name, so guard before reading it.
    const existingProperties = new Set(
      objectLiteral.properties.map((property) =>
        'name' in property && property.name ? getPropertyKey(property.name, source) : undefined
      )
    );
    const propertyTexts = managedProperties
      .filter((property) => !existingProperties.has(property.name))
      .map((property) => property.text);
    if (propertyTexts.length === 0) return;

    const oldContent = source.text;
    const insertionPoint = objectLiteral.getEnd() - 1;
    // The native TS AST does not reliably expose `properties.hasTrailingComma`, so scan the source
    // between the last property and the closing brace. Strip comments first so a comma inside a
    // trailing comment (e.g. `foo: 1 // a, b`) is not mistaken for a real trailing comma.
    const lastProperty = objectLiteral.properties.at(-1);
    const hasTrailingComma = lastProperty
      ? stripComments(oldContent.slice(lastProperty.getEnd(), insertionPoint)).includes(',')
      : false;
    const prefix = objectLiteral.properties.length > 0 && !hasTrailingComma ? ', ' : '';
    const newContent = `${oldContent.slice(0, insertionPoint)}${prefix}${propertyTexts.join(', ')}${oldContent.slice(
      insertionPoint
    )}`;
    await promisePool.run(() => fsUtil.generateFile(filePath, newContent));
  });
}

function getNextConfigObjectLiteral(
  filePath: string
): { source: ast.SourceFile; objectLiteral: ast.ObjectLiteralExpression } | undefined {
  const source = parseSourceFile(filePath);
  if (!source) return undefined;

  // The WillBooster standard declares the config as `const nextConfig: NextConfig = { ... }` and
  // exports it (possibly wrapped, e.g. `withSentryConfig(...)`), so the object literal is rarely
  // the direct operand of `export default`/`module.exports`. Collect every candidate and pick the
  // most authoritative one below.
  let directObjectLiteral: ast.ObjectLiteralExpression | undefined;
  let exportedIdentifier: string | undefined;
  const variableObjectLiterals = new Map<string, ast.ObjectLiteralExpression>();
  const typedConfigObjectLiterals: ast.ObjectLiteralExpression[] = [];

  const visit = (node: ast.Node): void => {
    if (ast.isExportAssignment(node)) {
      const objectLiteral = unwrapObjectLiteral(node.expression);
      if (objectLiteral) {
        directObjectLiteral ??= objectLiteral;
      } else if (ast.isIdentifier(node.expression)) {
        exportedIdentifier ??= node.expression.getText(source);
      }
    } else if (
      ast.isBinaryExpression(node) &&
      node.operatorToken.kind === ast.SyntaxKind.EqualsToken &&
      node.left.getText(source) === 'module.exports'
    ) {
      const objectLiteral = unwrapObjectLiteral(node.right);
      if (objectLiteral) {
        directObjectLiteral ??= objectLiteral;
      } else if (ast.isIdentifier(node.right)) {
        exportedIdentifier ??= node.right.getText(source);
      }
    } else if (ast.isVariableDeclaration(node) && node.initializer) {
      const objectLiteral = unwrapObjectLiteral(node.initializer);
      if (objectLiteral && ast.isIdentifier(node.name)) {
        variableObjectLiterals.set(node.name.getText(source), objectLiteral);
        // The `: NextConfig` annotation wbfy writes marks the canonical config object (accepting
        // qualified names such as `import('next').NextConfig`).
        const annotationType = node.type?.getText(source);
        if (annotationType !== undefined && isNextConfigType(annotationType)) {
          typedConfigObjectLiterals.push(objectLiteral);
        }
      }
    }
    node.forEachChild(visit);
  };
  source.forEachChild(visit);

  const objectLiteral =
    typedConfigObjectLiterals[0] ??
    directObjectLiteral ??
    (exportedIdentifier ? variableObjectLiterals.get(exportedIdentifier) : undefined) ??
    variableObjectLiterals.get('nextConfig');
  return objectLiteral ? { source, objectLiteral } : undefined;
}

// Unwrap `({ ... })` to the object literal.
function unwrapObjectLiteral(node: ast.Expression): ast.ObjectLiteralExpression | undefined {
  const current = unwrapParentheses(node);
  return ast.isObjectLiteralExpression(current) ? current : undefined;
}

// Peel wrapping parentheses off an expression.
function unwrapParentheses(node: ast.Expression): ast.Expression {
  let current = node;
  while (ast.isParenthesizedExpression(current)) {
    current = current.expression;
  }
  return current;
}

// Match both the bare `NextConfig` and qualified forms like `import('next').NextConfig`.
function isNextConfigType(typeText: string): boolean {
  return typeText === 'NextConfig' || typeText.endsWith('.NextConfig');
}

// Return a property key without surrounding quotes, so `'reactCompiler'` matches `reactCompiler`.
// Identifier, string-literal and numeric-literal names all expose the unquoted value via `.text`.
function getPropertyKey(name: ast.PropertyName, source: ast.SourceFile): string {
  return 'text' in name && typeof name.text === 'string' ? name.text : name.getText(source);
}

// Remove line and block comments from a source snippet.
function stripComments(text: string): string {
  return text.replaceAll(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '');
}
