import fs from 'node:fs';
import path from 'node:path';

import merge from 'deepmerge';
import ts from 'typescript';

import { logger } from '../logger.js';
import type { PackageConfig } from '../packageConfig.js';
import { fsUtil } from '../utils/fsUtil.js';
import { promisePool } from '../utils/promisePool.js';

type ParsedValue =
  | { kind: 'array'; value: ParsedValue[] }
  | { kind: 'literal'; value: string }
  | { kind: 'object'; value: ParsedObject };
type ParsedObject = Record<string, ParsedValue>;
interface ExtractedObjectLiteral {
  source: ts.SourceFile;
  node: ts.ObjectLiteralExpression;
}

const literal = (value: string): ParsedValue => ({ kind: 'literal', value });
const asArray = (value: ParsedValue[]): ParsedValue => ({ kind: 'array', value });
const asObject = (value: ParsedObject): ParsedValue => ({ kind: 'object', value });

const defaultConfig: ParsedObject = {
  forbidOnly: literal('!!process.env.CI'),
  retries: literal('process.env.PWDEBUG ? 0 : process.env.CI ? 5 : 1'),
  use: asObject({
    baseURL: literal('process.env.NEXT_PUBLIC_BASE_URL'),
    trace: literal("process.env.CI ? 'on-first-retry' : 'retain-on-failure'"),
    screenshot: literal("process.env.CI ? 'only-on-failure' : 'only-on-failure'"),
    video: literal("process.env.CI ? 'retain-on-failure' : 'retain-on-failure'"),
  }),
  webServer: asObject({
    command: literal("'yarn start-test-server'"),
    url: literal('process.env.NEXT_PUBLIC_BASE_URL'),
    reuseExistingServer: literal('!!process.env.CI'),
    timeout: literal('300_000'),
    stdout: literal("'pipe'"),
    stderr: literal("'pipe'"),
    env: literal(`{
  ...process.env,
  PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION: 'true',
}`),
    gracefulShutdown: literal(`{
  signal: 'SIGTERM',
  timeout: 500,
}`),
  }),
};

export async function fixPlaywrightConfig(config: PackageConfig): Promise<void> {
  const filePath = path.resolve(config.dirPath, `playwright.config.ts`);
  if (!fs.existsSync(filePath)) return;

  return logger.functionIgnoringException('fixPlaywrightConfig', async () => {
    await assertNextPublicBaseUrl(config.dirPath);

    const oldContent = await fs.promises.readFile(filePath, 'utf8');
    const extractedObjectLiteral = extractDefineConfigObjectLiteral(oldContent);
    if (!extractedObjectLiteral) return;

    const parsed = parseObjectLiteralExpression(extractedObjectLiteral.node, extractedObjectLiteral.source);
    if (!parsed) return;

    // Keep filling missing defaults, but don't overwrite local adjustments on every regeneration.
    const merged = merge.all<ParsedObject>([defaultConfig, parsed]);
    const hasStartTestServer = Boolean(config.packageJson?.scripts?.['start-test-server']);
    const hasExistingWebServer = Boolean(parsed.webServer);
    // Only drop wbfy's default server command. Repos with custom Playwright
    // server setup still need it even when they do not expose start-test-server.
    if (!hasStartTestServer && !hasExistingWebServer) {
      delete merged.webServer;
    }
    setWebServerCommand(config, merged);

    const newObjectLiteral = stringifyValue(asObject(merged), 0);
    const start = extractedObjectLiteral.node.getStart(extractedObjectLiteral.source);
    const end = extractedObjectLiteral.node.getEnd();
    const newContent = `${oldContent.slice(0, start)}${newObjectLiteral}${oldContent.slice(end)}`;

    await promisePool.run(() => fsUtil.generateFile(filePath, newContent));
  });
}

async function assertNextPublicBaseUrl(dirPath: string): Promise<void> {
  const envFilePaths = [
    path.resolve(dirPath, '.env'),
    path.resolve(dirPath, '.env.test'),
    path.resolve(dirPath, 'mise.toml'),
    path.resolve(dirPath, 'mise.test.toml'),
  ];
  for (const envFilePath of envFilePaths) {
    try {
      const content = await fs.promises.readFile(envFilePath, 'utf8');
      if (/NEXT_PUBLIC_BASE_URL\s*=/m.test(content)) {
        return;
      }
    } catch {
      // Missing env files are expected in some repos.
    }
  }

  throw new Error('NEXT_PUBLIC_BASE_URL is required for Playwright. Define NEXT_PUBLIC_BASE_URL in the target repo.');
}

function setWebServerCommand(config: PackageConfig, object: ParsedObject): void {
  const webServer = object.webServer;
  if (webServer?.kind !== 'object') return;

  // wbfy owns the package script, so Playwright should consistently call that
  // script while preserving the rest of each repository's webServer settings.
  webServer.value.command = literal(config.isBun ? "'bun start-test-server'" : "'yarn start-test-server'");
}

function extractDefineConfigObjectLiteral(content: string): ExtractedObjectLiteral | undefined {
  const source = ts.createSourceFile('playwright.config.ts', content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

  // TypeScript already understands nested object literals and template strings, so use
  // its AST ranges instead of a regex that can stop at the first inner closing brace.
  let found: ts.ObjectLiteralExpression | undefined;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isCallExpression(node) && node.expression.getText(source) === 'defineConfig') {
      const firstArgument = node.arguments[0];
      if (firstArgument && ts.isObjectLiteralExpression(firstArgument)) {
        found = firstArgument;
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);

  return found ? { source, node: found } : undefined;
}

function parseExpression(expression: ts.Expression, source: ts.SourceFile): ParsedValue | undefined {
  if (ts.isObjectLiteralExpression(expression)) {
    const parsedObject = parseObjectLiteralExpression(expression, source);
    return parsedObject ? asObject(parsedObject) : literal(expression.getText(source));
  }
  if (ts.isArrayLiteralExpression(expression)) {
    const elements = expression.elements.map((element) => parseExpression(element, source));
    if (elements.some((element): element is undefined => element === undefined)) {
      return literal(expression.getText(source));
    }
    return asArray(elements as ParsedValue[]);
  }
  return literal(expression.getText(source));
}

function parseObjectLiteralExpression(
  objectLiteral: ts.ObjectLiteralExpression,
  source: ts.SourceFile
): ParsedObject | undefined {
  const parsed: ParsedObject = {};
  for (const property of objectLiteral.properties) {
    if (!ts.isPropertyAssignment(property) || (!ts.isIdentifier(property.name) && !ts.isStringLiteral(property.name))) {
      continue;
    }
    const value = parseExpression(property.initializer, source);
    if (value === undefined) return;
    parsed[property.name.getText(source)] = value;
  }
  return parsed;
}

function stringifyValue(value: ParsedValue, level: number): string {
  const closingIndent = '  '.repeat(level);
  if (value.kind === 'array') {
    if (value.value.length === 0) return '[]';
    const indent = '  '.repeat(level + 1);
    const lines = value.value.map((item) => {
      const stringified = stringifyValue(item, level + 1).split('\n');
      stringified[stringified.length - 1] = `${stringified.at(-1)},`;
      if (item.kind === 'literal') {
        for (let index = 1; index < stringified.length; index += 1) {
          stringified[index] = `${indent}${stringified[index]}`;
        }
      }
      stringified[0] = `${indent}${stringified[0]}`;
      return stringified.join('\n');
    });
    return `[\n${lines.join('\n')}\n${closingIndent}]`;
  }
  if (value.kind === 'literal') return value.value;

  const indent = '  '.repeat(level + 1);
  const lines = Object.entries(value.value).map(([key, item]) => {
    const stringified = stringifyValue(item, level + 1).split('\n');
    stringified[stringified.length - 1] = `${stringified.at(-1)},`;
    if (item.kind === 'literal') {
      for (let index = 1; index < stringified.length; index += 1) {
        stringified[index] = `${indent}${stringified[index]}`;
      }
    }
    stringified[0] = `${indent}${key}: ${stringified[0]}`;
    return stringified.join('\n');
  });
  if (lines.length === 0) return `{\n${closingIndent}}`;
  return `{\n${lines.join('\n')}\n${closingIndent}}`;
}
