import fs from 'node:fs';
import path from 'node:path';

import ts from 'typescript';

import { logger } from '../logger.js';
import type { PackageConfig } from '../packageConfig.js';
import { fsUtil } from '../utils/fsUtil.js';
import { promisePool } from '../utils/promisePool.js';

export async function fixNextConfigJson(config: PackageConfig): Promise<void> {
  return logger.functionIgnoringException('fixNextConfigJson', async () => {
    const filePath = ['js', 'mjs', 'cjs']
      .map((ext) => path.resolve(config.dirPath, `next.config.${ext}`))
      .find((p) => fs.existsSync(p));
    if (!filePath) return;

    const oldContent = await fs.promises.readFile(filePath, 'utf8');
    const objectLiteral = getNextConfigObjectLiteral(oldContent);
    if (!objectLiteral) return;

    const existingProperties = new Set(objectLiteral.properties.map((property) => property.name?.getText()));
    const propertyTexts: string[] = [];
    if (!existingProperties.has('typescript')) {
      propertyTexts.push('typescript: { ignoreBuildErrors: true }');
    }
    if (propertyTexts.length === 0) return;

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

function getNextConfigObjectLiteral(content: string): ts.ObjectLiteralExpression | undefined {
  const source = ts.createSourceFile('next.config.js', content, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  let objectLiteral: ts.ObjectLiteralExpression | undefined;
  const visit = (node: ts.Node): void => {
    if (objectLiteral) return;
    if (ts.isExportAssignment(node) && ts.isObjectLiteralExpression(node.expression)) {
      objectLiteral = node.expression;
      return;
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      node.left.getText(source) === 'module.exports' &&
      ts.isObjectLiteralExpression(node.right)
    ) {
      objectLiteral = node.right;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return objectLiteral;
}
