import fs from 'node:fs';
import path from 'node:path';

import * as ast from 'typescript/unstable/ast';

import { logger } from '../logger.js';
import type { PackageConfig } from '../packageConfig.js';
import { fsUtil } from '../utils/fsUtil.js';
import { applyTextEdits, findProperty, insertPropertiesEdit, removePropertyEdit } from '../utils/objectLiteralEdit.js';
import { promisePool } from '../utils/promisePool.js';
import { parseSourceFile } from '../utils/typescriptApi.js';

// Settings every WillBooster Next.js project should carry. `name` is the top-level
// property key used to detect whether the setting already exists; `text` is inserted
// verbatim (a whole `key: value` pair) when the key is missing.
const managedProperties: readonly { name: string; text: string }[] = [
  { name: 'reactStrictMode', text: 'reactStrictMode: true' },
  { name: 'typescript', text: 'typescript: { ignoreBuildErrors: true }' },
];
const reactCompilerProperty = { name: 'reactCompiler', text: 'reactCompiler: true' };

export async function fixNextConfigJson(config: PackageConfig): Promise<void> {
  return logger.functionIgnoringException('fixNextConfigJson', async () => {
    const filePath = ['ts', 'mts', 'cts', 'js', 'mjs', 'cjs']
      .map((ext) => path.resolve(config.dirPath, `next.config.${ext}`))
      .find((p) => fs.existsSync(p));
    if (!filePath) return;

    const extracted = await getNextConfigObjectLiteral(filePath);
    if (!extracted) {
      console.warn(
        `Skipped updating ${filePath} because it exports neither an object literal nor a function returning one.`
      );
      return;
    }
    const { source, objectLiteral } = extracted;

    // vinext ignores `reactCompiler`; fixers/viteConfig.ts enables the compiler in vite.config.ts instead.
    const removedProperty = config.depending.vinext
      ? findProperty(objectLiteral, reactCompilerProperty.name, source)
      : undefined;
    const propertyTexts = (config.depending.vinext ? managedProperties : [reactCompilerProperty, ...managedProperties])
      .filter((property) => !findProperty(objectLiteral, property.name, source))
      .map((property) => property.text);
    const edits = [
      ...(removedProperty ? [removePropertyEdit(source, removedProperty)] : []),
      ...(propertyTexts.length > 0
        ? [insertPropertiesEdit(source, objectLiteral, propertyTexts, removedProperty)]
        : []),
    ];
    if (edits.length === 0) return;

    const newContent = applyTextEdits(source.text, edits);
    await promisePool.runAndWaitForReturnValue(() => fsUtil.generateFile(filePath, newContent));
  });
}

async function getNextConfigObjectLiteral(
  filePath: string
): Promise<{ source: ast.SourceFile; objectLiteral: ast.ObjectLiteralExpression } | undefined> {
  const source = await parseSourceFile(filePath);
  if (!source) return undefined;

  // The WillBooster standard declares the config as `const nextConfig: NextConfig = { ... }` and
  // exports it (possibly wrapped, e.g. `withSentryConfig(...)`), so the object literal is rarely
  // the direct operand of `export default`/`module.exports`. Collect every candidate and pick the
  // most authoritative one below.
  let directObjectLiteral: ast.ObjectLiteralExpression | undefined;
  let exportedIdentifier: string | undefined;
  const variableObjectLiterals = new Map<string, ast.ObjectLiteralExpression>();
  const typedConfigObjectLiterals: ast.ObjectLiteralExpression[] = [];

  const recordExport = (expression: ast.Expression): void => {
    const objectLiteral = unwrapObjectLiteral(expression);
    if (objectLiteral) {
      directObjectLiteral ??= objectLiteral;
    } else if (ast.isIdentifier(expression)) {
      exportedIdentifier ??= expression.getText(source);
    }
  };
  const visit = (node: ast.Node): void => {
    if (ast.isFunctionDeclaration(node) && isDefaultExport(node)) {
      const objectLiteral = getReturnedObjectLiteral(node);
      directObjectLiteral ??= objectLiteral;
      if (objectLiteral && node.type && isNextConfigType(node.type.getText(source))) {
        typedConfigObjectLiterals.push(objectLiteral);
      }
    } else if (ast.isExportAssignment(node)) {
      recordExport(node.expression);
    } else if (
      ast.isBinaryExpression(node) &&
      node.operatorToken.kind === ast.SyntaxKind.EqualsToken &&
      node.left.getText(source) === 'module.exports'
    ) {
      recordExport(node.right);
    } else if (ast.isVariableDeclaration(node) && node.initializer) {
      const objectLiteral = unwrapObjectLiteral(node.initializer);
      if (objectLiteral && ast.isIdentifier(node.name)) {
        variableObjectLiterals.set(node.name.getText(source), objectLiteral);
        const annotationType = getConfigTypeAnnotation(node, node.initializer)?.getText(source);
        if (annotationType !== undefined && isNextConfigType(annotationType)) {
          typedConfigObjectLiterals.push(objectLiteral);
        }
      }
    }
    node.forEachChild(visit);
  };
  source.forEachChild(visit);

  const exportedObjectLiteral =
    directObjectLiteral ?? (exportedIdentifier ? variableObjectLiterals.get(exportedIdentifier) : undefined);
  const objectLiteral =
    selectTypedConfig(exportedObjectLiteral, typedConfigObjectLiterals) ??
    exportedObjectLiteral ??
    variableObjectLiterals.get('nextConfig');
  return objectLiteral ? { source, objectLiteral } : undefined;
}

/** An exported typed config outranks any other `NextConfig` object (e.g. a helper spread into it). */
function selectTypedConfig(
  exported: ast.ObjectLiteralExpression | undefined,
  typed: ast.ObjectLiteralExpression[]
): ast.ObjectLiteralExpression | undefined {
  return exported && typed.includes(exported) ? exported : typed[0];
}

/** Returns the object literal that `node` is, or that a phase function `node` returns (`(phase) => ({ ... })`). */
function unwrapObjectLiteral(node: ast.Expression): ast.ObjectLiteralExpression | undefined {
  const current = unwrapParentheses(node);
  if (ast.isObjectLiteralExpression(current)) return current;
  if (ast.isArrowFunction(current) || ast.isFunctionExpression(current)) return getReturnedObjectLiteral(current);
  return undefined;
}

function getReturnedObjectLiteral(
  fn: ast.ArrowFunction | ast.FunctionExpression | ast.FunctionDeclaration
): ast.ObjectLiteralExpression | undefined {
  const { body } = fn;
  const [statement, ...rest] = body && ast.isBlock(body) ? body.statements : [];
  const returned =
    body && !ast.isBlock(body)
      ? body
      : rest.length === 0 && statement && ast.isReturnStatement(statement)
        ? statement.expression
        : undefined;
  const expression = returned && unwrapParentheses(returned);
  return expression && ast.isObjectLiteralExpression(expression) ? expression : undefined;
}

/**
 * The `: NextConfig` annotation wbfy writes marks the canonical config object, whether it annotates the
 * variable or the return type of a phase function.
 */
function getConfigTypeAnnotation(
  declaration: ast.VariableDeclaration,
  initializer: ast.Expression
): ast.TypeNode | undefined {
  const value = unwrapParentheses(initializer);
  return ast.isArrowFunction(value) || ast.isFunctionExpression(value) ? value.type : declaration.type;
}

function isDefaultExport(node: ast.FunctionDeclaration): boolean {
  const modifiers = node.modifiers ?? [];
  return (
    modifiers.some((m) => m.kind === ast.SyntaxKind.ExportKeyword) &&
    modifiers.some((m) => m.kind === ast.SyntaxKind.DefaultKeyword)
  );
}

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
