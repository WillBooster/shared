import fs from 'node:fs';
import path from 'node:path';

import * as ast from 'typescript/unstable/ast';

import { logger } from '../logger.js';
import type { PackageConfig } from '../packageConfig.js';
import { fsUtil } from '../utils/fsUtil.js';
import { promisePool } from '../utils/promisePool.js';
import { parseSourceFile } from '../utils/typescriptApi.js';

export async function fixNextConfigJson(config: PackageConfig): Promise<void> {
  return logger.functionIgnoringException('fixNextConfigJson', async () => {
    const filePath = ['js', 'mjs', 'cjs']
      .map((ext) => path.resolve(config.dirPath, `next.config.${ext}`))
      .find((p) => fs.existsSync(p));
    if (!filePath) return;

    const extracted = getNextConfigObjectLiteral(filePath);
    if (!extracted) return;
    const { source, objectLiteral } = extracted;

    // `properties` includes spread assignments (`...rest`) that carry no name, so guard before reading it.
    const existingProperties = new Set(
      objectLiteral.properties.map((property) => ('name' in property ? property.name?.getText(source) : undefined))
    );
    const propertyTexts: string[] = [];
    if (!existingProperties.has('typescript')) {
      propertyTexts.push('typescript: { ignoreBuildErrors: true }');
    }
    if (propertyTexts.length === 0) return;

    const oldContent = source.text;
    const insertionPoint = objectLiteral.getEnd() - 1;
    const lastProperty = objectLiteral.properties.at(-1);
    const hasTrailingComma = lastProperty
      ? oldContent.slice(lastProperty.getEnd(), insertionPoint).includes(',')
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

  let objectLiteral: ast.ObjectLiteralExpression | undefined;
  const visit = (node: ast.Node): void => {
    if (objectLiteral) return;
    if (ast.isExportAssignment(node) && ast.isObjectLiteralExpression(node.expression)) {
      objectLiteral = node.expression;
      return;
    }
    if (
      ast.isBinaryExpression(node) &&
      node.operatorToken.kind === ast.SyntaxKind.EqualsToken &&
      node.left.getText(source) === 'module.exports' &&
      ast.isObjectLiteralExpression(node.right)
    ) {
      objectLiteral = node.right;
      return;
    }
    node.forEachChild(visit);
  };
  source.forEachChild(visit);
  return objectLiteral ? { source, objectLiteral } : undefined;
}
