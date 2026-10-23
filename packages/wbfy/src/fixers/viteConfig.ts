import fs from 'node:fs';
import path from 'node:path';

import * as ast from 'typescript/unstable/ast';

import { logger } from '../logger.js';
import type { PackageConfig } from '../packageConfig.js';
import { fsUtil } from '../utils/fsUtil.js';
import { applyTextEdits, findProperties, insertPropertiesEdit, type TextEdit } from '../utils/objectLiteralEdit.js';
import { promisePool } from '../utils/promisePool.js';
import { parseSourceFile } from '../utils/typescriptApi.js';
import { getOxcTransformReactPeerRange } from '../utils/vitePluginReact.js';

// vinext forwards `react` to @vitejs/plugin-react, whose `compiler` option enables the React Compiler.
const reactCompilerOptionPath = ['react', 'compiler', 'reportDiagnostics'] as const;

type ReactCompilerPlan =
  | { kind: 'enabled' }
  | { kind: 'edit'; filePath: string; content: string }
  | { kind: 'unsupported'; reason: string };

/** Enables the React Compiler through the `vinext(...)` call in vite.config.ts. */
export async function fixViteConfig(config: PackageConfig): Promise<void> {
  return logger.functionIgnoringException('fixViteConfig', async () => {
    const plan = await planReactCompiler(config);
    if (plan.kind === 'unsupported') {
      console.warn(`Skipped enabling the React Compiler in ${config.dirPath} because ${plan.reason}.`);
    } else if (plan.kind === 'edit') {
      await promisePool.runAndWaitForReturnValue(() => fsUtil.generateFile(plan.filePath, plan.content));
    }
  });
}

/** Whether the React Compiler is enabled in the vinext package once {@link fixViteConfig} has run. */
export async function enablesViteReactCompiler(config: PackageConfig): Promise<boolean> {
  const plan = await planReactCompiler(config);
  return plan.kind !== 'unsupported';
}

async function planReactCompiler(config: PackageConfig): Promise<ReactCompilerPlan> {
  if (!getOxcTransformReactPeerRange(config.dirPath)) {
    return {
      kind: 'unsupported',
      reason:
        'the installed @vitejs/plugin-react does not peer-require oxc-transform-react; update @vitejs/plugin-react',
    };
  }
  const filePath = path.resolve(config.dirPath, 'vite.config.ts');
  if (!fs.existsSync(filePath)) return { kind: 'unsupported', reason: 'vite.config.ts does not exist' };
  const source = await parseSourceFile(filePath);
  if (!source) return { kind: 'unsupported', reason: 'vite.config.ts could not be parsed' };

  const calls = findVinextCalls(source);
  const [call] = calls;
  if (calls.length !== 1 || !call) {
    return { kind: 'unsupported', reason: 'vite.config.ts does not call the default export of vinext exactly once' };
  }
  const [options, ...extraArguments] = call.arguments;
  let edit: TextEdit | 'enabled' | undefined;
  if (!options) {
    const insertionPoint = call.getEnd() - 1;
    edit = { start: insertionPoint, end: insertionPoint, text: buildObjectText(reactCompilerOptionPath) };
  } else if (ast.isObjectLiteralExpression(options) && extraArguments.length === 0) {
    edit = planObjectLiteral(source, options, reactCompilerOptionPath);
  }
  if (!edit) {
    return {
      kind: 'unsupported',
      reason: `the \`${reactCompilerOptionPath.join('.')}\` path of the vinext() options in vite.config.ts goes through a spread, a duplicate key, a \`false\` opt-out, or a non-literal value; rewrite it so that vinext() takes an object literal without them and registers @vitejs/plugin-react itself`,
    };
  }
  return edit === 'enabled'
    ? { kind: 'enabled' }
    : { kind: 'edit', filePath, content: applyTextEdits(source.text, [edit]) };
}

function findVinextCalls(source: ast.SourceFile): ast.CallExpression[] {
  const vinextName = source.statements
    .filter(ast.isImportDeclaration)
    .find(
      (statement) =>
        ast.isStringLiteral(statement.moduleSpecifier) &&
        statement.moduleSpecifier.text === 'vinext' &&
        statement.importClause?.name
    )
    ?.importClause?.name?.getText(source);
  if (!vinextName) return [];

  const calls: ast.CallExpression[] = [];
  const visit = (node: ast.Node): void => {
    if (
      ast.isCallExpression(node) &&
      ast.isIdentifier(node.expression) &&
      node.expression.getText(source) === vinextName
    ) {
      calls.push(node);
    }
    node.forEachChild(visit);
  };
  source.forEachChild(visit);
  return calls;
}

/** Returns the edit that sets `keys` to true, `'enabled'` when already set, or `undefined` when it cannot be set safely. */
function planObjectLiteral(
  source: ast.SourceFile,
  objectLiteral: ast.ObjectLiteralExpression,
  keys: readonly string[]
): TextEdit | 'enabled' | undefined {
  const [key, ...restKeys] = keys;
  if (!key) return undefined;
  // A spread or a duplicate key may override the property this edit reads or writes.
  if (objectLiteral.properties.some(ast.isSpreadAssignment)) return undefined;
  const properties = findProperties(objectLiteral, key, source);
  const [property] = properties;
  if (!property) return insertPropertiesEdit(source, objectLiteral, [`${key}: ${buildValueText(restKeys)}`]);
  if (properties.length > 1 || !ast.isPropertyAssignment(property)) return undefined;
  const { initializer } = property;
  if (restKeys.length === 0) {
    if (initializer.kind === ast.SyntaxKind.TrueKeyword) return 'enabled';
    return replaceNodeEdit(source, initializer, 'true');
  }
  if (ast.isObjectLiteralExpression(initializer)) return planObjectLiteral(source, initializer, restKeys);
  // `true` selects the default options, so it is upgraded to the options object. `false` is a
  // deliberate opt-out (e.g. `react: false` for an app registering @vitejs/plugin-react itself).
  if (initializer.kind === ast.SyntaxKind.TrueKeyword) {
    return replaceNodeEdit(source, initializer, buildValueText(restKeys));
  }
  return undefined;
}

function replaceNodeEdit(source: ast.SourceFile, node: ast.Node, text: string): TextEdit {
  return { start: node.getStart(source), end: node.getEnd(), text };
}

function buildValueText(keys: readonly string[]): string {
  return keys.length === 0 ? 'true' : buildObjectText(keys);
}

function buildObjectText([key, ...restKeys]: readonly string[]): string {
  return `{ ${key}: ${buildValueText(restKeys)} }`;
}
