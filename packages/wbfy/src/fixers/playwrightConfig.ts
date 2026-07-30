import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { simpleGit } from 'simple-git';
import * as ast from 'typescript/unstable/ast';

import { logger } from '../logger.js';
import type { PackageConfig } from '../packageConfig.js';
import { fsUtil } from '../utils/fsUtil.js';
import { promisePool } from '../utils/promisePool.js';
import { parseSourceFile } from '../utils/typescriptApi.js';

type ParsedValue =
  | { kind: 'array'; value: ParsedValue[] }
  | { kind: 'literal'; value: string }
  | { kind: 'object'; value: ParsedObject };
type ObjectMember = { kind: 'extra'; index: number } | { kind: 'property'; key: string };
interface ParsedObject {
  extraMembers: string[];
  memberOrder: ObjectMember[];
  properties: Record<string, ParsedValue>;
}
interface ExtractedObjectLiteral {
  source: ast.SourceFile;
  node: ast.ObjectLiteralExpression;
}
interface FileHistoryEntry {
  commit: string;
  subject: string;
  commitPath: string;
  parentPath: string | undefined;
}
interface ExtractedCommand {
  command: ParsedValue;
  identifiers: Set<string>;
}

const literal = (value: string): ParsedValue => ({ kind: 'literal', value });
const asArray = (value: ParsedValue[]): ParsedValue => ({ kind: 'array', value });
const asObject = (properties: Record<string, ParsedValue>, extraMembers: string[] = []): ParsedValue => ({
  kind: 'object',
  value: toParsedObject(properties, extraMembers),
});

function createDefaultConfig(config: PackageConfig, shouldUseAppServerDefaults: boolean): ParsedObject {
  const use = toParsedObject({
    trace: literal("process.env.CI ? 'on-first-retry' : 'retain-on-failure'"),
    screenshot: literal("process.env.CI ? 'only-on-failure' : 'on'"),
    video: literal("process.env.CI ? 'on-first-retry' : 'retain-on-failure'"),
  });

  if (shouldUseAppServerDefaults) {
    use.properties.baseURL = literal('process.env.NEXT_PUBLIC_BASE_URL');
    use.memberOrder.unshift({ kind: 'property', key: 'baseURL' });
  }

  return toParsedObject({
    forbidOnly: literal('!!process.env.CI'),
    retries: literal('process.env.PWDEBUG ? 0 : process.env.CI ? 5 : 1'),
    use: { kind: 'object', value: use },
    ...(shouldUseAppServerDefaults
      ? {
          webServer: asObject({
            command: literal(getWbStartTestCommand()),
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
        }
      : {}),
  });
}

function toParsedObject(properties: Record<string, ParsedValue>, extraMembers: string[] = []): ParsedObject {
  return {
    extraMembers,
    memberOrder: [
      ...Object.keys(properties).map((key): ObjectMember => ({ kind: 'property', key })),
      ...extraMembers.map((_, index): ObjectMember => ({ kind: 'extra', index })),
    ],
    properties,
  };
}

export async function fixPlaywrightConfig(config: PackageConfig): Promise<void> {
  const filePath = path.resolve(config.dirPath, `playwright.config.ts`);
  if (!fs.existsSync(filePath)) return;

  return logger.functionIgnoringException('fixPlaywrightConfig', async () => {
    const extractedObjectLiteral = extractDefineConfigObjectLiteral(filePath);
    if (!extractedObjectLiteral) return;

    const parsed = parseObjectLiteralExpression(extractedObjectLiteral.node, extractedObjectLiteral.source);
    if (!parsed) return;

    const shouldUseAppServerDefaults =
      (await doesDefineNextPublicBaseUrl(config.dirPath)) && shouldManageAppServerDefaults(config, parsed);
    const defaultConfig = createDefaultConfig(config, shouldUseAppServerDefaults);
    const merged = mergeParsedObjects(defaultConfig, parsed);
    applyManagedUseDefaults(merged, defaultConfig);
    await setWebServerCommand(merged, filePath, extractedObjectLiteral.source);

    const newObjectLiteral = stringifyValue({ kind: 'object', value: merged }, 0);
    const oldContent = extractedObjectLiteral.source.text;
    const start = extractedObjectLiteral.node.getStart(extractedObjectLiteral.source);
    const end = extractedObjectLiteral.node.getEnd();
    const newContent = `${oldContent.slice(0, start)}${newObjectLiteral}${oldContent.slice(end)}`;

    await promisePool.run(() => fsUtil.generateFile(filePath, newContent));
  });
}

function mergeParsedObjects(base: ParsedObject, override: ParsedObject): ParsedObject {
  const overridePropertyKeys = new Set(Object.keys(override.properties));
  const extraMembers = [...base.extraMembers, ...override.extraMembers];
  // Keep default-only members before parsed members so spreads and explicit local properties retain precedence.
  const memberOrder = [
    ...base.memberOrder.filter((member) => member.kind !== 'property' || !overridePropertyKeys.has(member.key)),
    ...override.memberOrder.map((member): ObjectMember => {
      if (member.kind === 'property') return member;
      return { kind: 'extra', index: base.extraMembers.length + member.index };
    }),
  ];
  const properties = { ...base.properties };
  for (const [key, value] of Object.entries(override.properties)) {
    properties[key] = mergeParsedValue(properties[key], value);
  }
  return { extraMembers, memberOrder, properties };
}

function mergeParsedValue(base: ParsedValue | undefined, override: ParsedValue): ParsedValue {
  if (base?.kind === 'object' && override.kind === 'object') {
    return { kind: 'object', value: mergeParsedObjects(base.value, override.value) };
  }
  return override;
}

function applyManagedUseDefaults(config: ParsedObject, defaultConfig: ParsedObject): void {
  const use = config.properties.use;
  const defaultUse = defaultConfig.properties.use;
  if (use?.kind !== 'object' || defaultUse?.kind !== 'object') return;

  for (const key of ['trace', 'screenshot', 'video']) {
    const defaultValue = defaultUse.value.properties[key];
    if (defaultValue) {
      use.value.properties[key] = defaultValue;
    }
  }
}

function shouldManageAppServerDefaults(config: PackageConfig, parsed: ParsedObject): boolean {
  return (
    config.depending.next ||
    parsed.properties.webServer !== undefined ||
    doesObjectHaveBaseUrl(parsed.properties.use) ||
    doesValueContainLiteral({ kind: 'object', value: parsed }, 'NEXT_PUBLIC_BASE_URL')
  );
}

function doesObjectHaveBaseUrl(value: ParsedValue | undefined): boolean {
  return value?.kind === 'object' && value.value.properties.baseURL !== undefined;
}

function doesValueContainLiteral(value: ParsedValue, literalText: string): boolean {
  if (value.kind === 'literal') return value.value.includes(literalText);
  if (value.kind === 'array') return value.value.some((child) => doesValueContainLiteral(child, literalText));
  return (
    value.value.extraMembers.some((member) => member.includes(literalText)) ||
    Object.values(value.value.properties).some((child) => doesValueContainLiteral(child, literalText))
  );
}

async function doesDefineNextPublicBaseUrl(dirPath: string): Promise<boolean> {
  for (const envFilePath of getEnvFilePaths(dirPath)) {
    try {
      const content = await fs.promises.readFile(envFilePath, 'utf8');
      if (/NEXT_PUBLIC_BASE_URL\s*=/m.test(content)) {
        return true;
      }
    } catch {
      // Missing env files are expected in some repos.
    }
  }

  // Some Playwright configs only define browser projects or fixtures and do not
  // start a web app. Avoid forcing an app-server URL into those packages.
  return false;
}

function getEnvFilePaths(dirPath: string): string[] {
  const envFileNames = ['fnox.toml', 'mise.toml', 'mise.test.toml'];
  const envFilePaths: string[] = [];

  for (let currentDirPath = path.resolve(dirPath); ; currentDirPath = path.dirname(currentDirPath)) {
    envFilePaths.push(...envFileNames.map((fileName) => path.resolve(currentDirPath, fileName)));

    // Playwright configs often live in packages/* while shared env files live at the
    // repository root, so walk upward until the target repo boundary.
    if (fs.existsSync(path.resolve(currentDirPath, '.git'))) break;

    const parentDirPath = path.dirname(currentDirPath);
    if (parentDirPath === currentDirPath) break;
  }

  return envFilePaths;
}

async function setWebServerCommand(
  object: ParsedObject,
  filePath: string,
  currentSource: ast.SourceFile
): Promise<void> {
  const webServer = object.properties.webServer;
  if (webServer?.kind !== 'object') return;

  const command = webServer.value.properties.command;
  // Libraries can use Playwright's webServer to build and launch a fixture even though `wb start`
  // intentionally has no test server for the library itself. Preserve those custom lifecycle
  // commands; only add or migrate the command when wbfy already owns it.
  if (command && !isGeneratedWbStartTestCommand(command)) return;

  const historicalCommand = command && (await findWbfyOverwrittenWebServerCommand(filePath, command, currentSource));
  if (historicalCommand) {
    webServer.value.properties.command = historicalCommand;
    return;
  }

  // Playwright requires `command` whenever `webServer` exists; an externally managed server should
  // omit `webServer` instead. Keep filling this required field when a partial managed block lacks it.
  webServer.value.properties.command = literal(getWbStartTestCommand());
}

async function findWbfyOverwrittenWebServerCommand(
  filePath: string,
  currentCommand: ParsedValue,
  currentSource: ast.SourceFile
): Promise<ParsedValue | undefined> {
  try {
    const initialGit = simpleGit(path.dirname(filePath));
    const rootDirOutput = await initialGit.revparse(['--show-toplevel']);
    const rootDirPath = rootDirOutput.trim();
    // Git reports canonical paths on macOS (/private/var), while callers can reach the same file
    // through a symlinked path (/var). Compare physical paths so history lookup stays repository-local.
    const relativeFilePath = path.relative(rootDirPath, fs.realpathSync(filePath));
    const git = simpleGit(rootDirPath);
    const headCommand = extractWebServerCommand(await git.show([`HEAD:${relativeFilePath}`]))?.command;
    // An uncommitted switch to the standard server command is repository-owned, not historical
    // damage. Recover only when the working tree still matches the committed command.
    if (!headCommand || !areCommandsEqual(currentCommand, headCommand)) return undefined;

    const logOutput = await git.raw([
      'log',
      '-z',
      '--follow',
      '--name-status',
      '--format=%x1e%H%x00%s',
      '--',
      relativeFilePath,
    ]);
    for (const entry of parseFileHistory(logOutput)) {
      if (!entry.parentPath) return undefined;

      const commitCommand = extractWebServerCommand(await git.show([`${entry.commit}:${entry.commitPath}`]));
      const previousCommand = extractWebServerCommand(await git.show([`${entry.commit}^:${entry.parentPath}`]));
      if (!commitCommand || !previousCommand) return undefined;
      if (areCommandsEqual(commitCommand.command, previousCommand.command)) continue;

      // Only the latest command-changing transition can explain the current generated value. Older
      // wbfy overwrites are obsolete once a maintainer has deliberately changed the command again.
      if (!isHistoricallyGeneratedWbStartTestCommand(commitCommand.command)) return undefined;
      if (isHistoricallyGeneratedWbStartTestCommand(previousCommand.command)) continue;
      if (!isWbfyCommitSubject(entry.subject)) return undefined;
      return areHistoricalIdentifiersAvailable(previousCommand.identifiers, currentSource)
        ? previousCommand.command
        : undefined;
    }
  } catch {
    // Repositories without usable Git history still receive the canonical generated command below.
  }
  return undefined;
}

function parseFileHistory(output: string): FileHistoryEntry[] {
  return output
    .split('\u001E')
    .slice(1)
    .flatMap((record): FileHistoryEntry[] => {
      const [commit, subject, rawStatus, firstPath, secondPath] = record.split('\0');
      const status = rawStatus?.trimStart();
      if (!commit || subject === undefined || !status || !firstPath) return [];
      if (status.startsWith('R')) {
        return secondPath ? [{ commit, subject, commitPath: secondPath, parentPath: firstPath }] : [];
      }
      return [{ commit, subject, commitPath: firstPath, parentPath: status === 'A' ? undefined : firstPath }];
    });
}

function extractWebServerCommand(content: string): ExtractedCommand | undefined {
  const tempDirPath = fs.mkdtempSync(path.join(os.tmpdir(), 'wbfy-playwright-history-'));
  const tempFilePath = path.resolve(tempDirPath, 'playwright.config.ts');
  try {
    fs.writeFileSync(tempFilePath, content);
    const extracted = extractDefineConfigObjectLiteral(tempFilePath);
    if (!extracted) return undefined;
    const webServer = getObjectPropertyInitializer(extracted.node, 'webServer');
    if (!webServer || !ast.isObjectLiteralExpression(webServer)) return undefined;
    const commandExpression = getObjectPropertyInitializer(webServer, 'command');
    const command = commandExpression && parseExpression(commandExpression, extracted.source);
    return command ? { command, identifiers: collectReferencedIdentifiers(commandExpression) } : undefined;
  } finally {
    fs.rmSync(tempDirPath, { force: true, recursive: true });
  }
}

function getObjectPropertyInitializer(
  objectLiteral: ast.ObjectLiteralExpression,
  propertyName: string
): ast.Expression | undefined {
  for (const property of objectLiteral.properties) {
    if (
      ast.isPropertyAssignment(property) &&
      (ast.isIdentifier(property.name) || ast.isStringLiteral(property.name)) &&
      property.name.text === propertyName
    ) {
      return property.initializer;
    }
  }
  return undefined;
}

function collectReferencedIdentifiers(expression: ast.Expression): Set<string> {
  const identifiers = new Set<string>();
  const visit = (node: ast.Node): void => {
    if (ast.isIdentifier(node)) {
      identifiers.add(node.text);
      return;
    }
    if (ast.isPropertyAccessExpression(node)) {
      visit(node.expression);
      return;
    }
    node.forEachChild(visit);
  };
  visit(expression);
  return identifiers;
}

function areHistoricalIdentifiersAvailable(identifiers: Set<string>, currentSource: ast.SourceFile): boolean {
  if (identifiers.size === 0) return true;
  const availableIdentifiers = collectTopLevelValueBindings(currentSource);
  return [...identifiers].every(
    (identifier) => availableIdentifiers.has(identifier) || knownRuntimeGlobals.has(identifier)
  );
}

function collectTopLevelValueBindings(source: ast.SourceFile): Set<string> {
  const bindings = new Set<string>();
  for (const statement of source.statements) {
    if (ast.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        collectBindingName(declaration.name, bindings);
      }
      continue;
    }
    if (
      (ast.isFunctionDeclaration(statement) || ast.isClassDeclaration(statement) || ast.isEnumDeclaration(statement)) &&
      statement.name
    ) {
      bindings.add(statement.name.text);
      continue;
    }
    if (!ast.isImportDeclaration(statement)) continue;
    const importClause = statement.importClause;
    if (!importClause || importClause.phaseModifier === ast.SyntaxKind.TypeKeyword) continue;
    if (importClause.name) bindings.add(importClause.name.text);
    const namedBindings = importClause.namedBindings;
    if (namedBindings && ast.isNamespaceImport(namedBindings)) {
      bindings.add(namedBindings.name.text);
    } else if (namedBindings && ast.isNamedImports(namedBindings)) {
      for (const element of namedBindings.elements) {
        if (!element.isTypeOnly) bindings.add(element.name.text);
      }
    }
  }
  return bindings;
}

function collectBindingName(name: ast.BindingName, bindings: Set<string>): void {
  if (ast.isIdentifier(name)) {
    bindings.add(name.text);
    return;
  }
  for (const element of name.elements) {
    if (element.name) collectBindingName(element.name, bindings);
  }
}

function areCommandsEqual(left: ParsedValue, right: ParsedValue): boolean {
  return left.kind === 'literal' && right.kind === 'literal' && left.value.trim() === right.value.trim();
}

function isWbfyCommitSubject(subject: string): boolean {
  return /^chore: willboosterify this repo(?: \(#\d+\))?$/u.test(subject);
}

function isGeneratedWbStartTestCommand(command: ParsedValue): boolean {
  if (command.kind !== 'literal') return false;
  // Match only commands emitted by past wbfy versions. A broader command-shaped regex could
  // overwrite a repository's deliberate wrapper while trying to recognize generated content.
  return /^'(?:(?:bun|yarn) (?:wb start --mode test|start-test-server)|wb start --mode test)'$/u.test(
    command.value.trim()
  );
}

function isHistoricallyGeneratedWbStartTestCommand(command: ParsedValue): boolean {
  if (isGeneratedWbStartTestCommand(command)) return true;
  if (command.kind !== 'literal') return false;
  return /^'(?:yarn start-test|bun run (?:wb start --mode test|start-test-server)|bun --bun wb start --mode test)'$/u.test(
    command.value.trim()
  );
}

const knownRuntimeGlobals = new Set(['Buffer', 'URL', 'clearTimeout', 'console', 'process', 'setTimeout', 'undefined']);

function getWbStartTestCommand(): string {
  return `'bun wb start --mode test'`;
}

function extractDefineConfigObjectLiteral(filePath: string): ExtractedObjectLiteral | undefined {
  const source = parseSourceFile(filePath);
  if (!source) return undefined;

  // TypeScript already understands nested object literals and template strings, so use
  // its AST ranges instead of a regex that can stop at the first inner closing brace.
  let found: ast.ObjectLiteralExpression | undefined;
  const visit = (node: ast.Node): void => {
    if (found) return;
    if (ast.isCallExpression(node) && node.expression.getText(source) === 'defineConfig') {
      const firstArgument = node.arguments[0];
      if (firstArgument && ast.isObjectLiteralExpression(firstArgument)) {
        found = firstArgument;
        return;
      }
    }
    node.forEachChild(visit);
  };
  source.forEachChild(visit);

  return found ? { source, node: found } : undefined;
}

function parseExpression(expression: ast.Expression, source: ast.SourceFile): ParsedValue | undefined {
  if (ast.isObjectLiteralExpression(expression)) {
    const parsedObject = parseObjectLiteralExpression(expression, source);
    return parsedObject ? { kind: 'object', value: parsedObject } : literal(expression.getText(source));
  }
  if (ast.isArrayLiteralExpression(expression)) {
    const elements = expression.elements.map((element) => parseExpression(element, source));
    if (elements.some((element): element is undefined => element === undefined)) {
      return literal(expression.getText(source));
    }
    return asArray(elements as ParsedValue[]);
  }
  return literal(expression.getText(source));
}

function parseObjectLiteralExpression(
  objectLiteral: ast.ObjectLiteralExpression,
  source: ast.SourceFile
): ParsedObject | undefined {
  const parsed: ParsedObject = { extraMembers: [], memberOrder: [], properties: {} };
  for (const property of objectLiteral.properties) {
    if (ast.isShorthandPropertyAssignment(property)) {
      const key = property.name.getText(source);
      parsed.properties[key] = literal(key);
      parsed.memberOrder.push({ kind: 'property', key });
      continue;
    }
    if (
      !ast.isPropertyAssignment(property) ||
      (!ast.isIdentifier(property.name) && !ast.isStringLiteral(property.name))
    ) {
      const index = parsed.extraMembers.push(property.getText(source)) - 1;
      parsed.memberOrder.push({ kind: 'extra', index });
      continue;
    }
    const value = parseExpression(property.initializer, source);
    if (value === undefined) return;
    const key = property.name.getText(source);
    parsed.properties[key] = value;
    parsed.memberOrder.push({ kind: 'property', key });
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
  const emittedProperties = new Set<string>();
  const lastPropertyIndexByKey = getLastPropertyIndexByKey(value.value.memberOrder);
  const lines = value.value.memberOrder.flatMap((member, index) => {
    if (member.kind === 'extra') {
      return [stringifyObjectMember(value.value.extraMembers[member.index] ?? '', indent)];
    }

    if (lastPropertyIndexByKey.get(member.key) !== index) return [];
    const item = value.value.properties[member.key];
    if (!item || emittedProperties.has(member.key)) return [];
    emittedProperties.add(member.key);
    return [stringifyObjectProperty(member.key, item, level, indent)];
  });
  lines.push(
    ...Object.entries(value.value.properties)
      .filter(([key]) => !emittedProperties.has(key))
      .map(([key, item]) => stringifyObjectProperty(key, item, level, indent))
  );
  if (lines.length === 0) return `{\n${closingIndent}}`;
  return `{\n${lines.join('\n')}\n${closingIndent}}`;
}

function getLastPropertyIndexByKey(memberOrder: ObjectMember[]): Map<string, number> {
  const lastPropertyIndexByKey = new Map<string, number>();
  for (const [index, member] of memberOrder.entries()) {
    if (member.kind === 'property') {
      lastPropertyIndexByKey.set(member.key, index);
    }
  }
  return lastPropertyIndexByKey;
}

function stringifyObjectProperty(key: string, item: ParsedValue, level: number, indent: string): string {
  const stringified = stringifyValue(item, level + 1).split('\n');
  stringified[stringified.length - 1] = `${stringified.at(-1)},`;
  if (item.kind === 'literal') {
    for (let index = 1; index < stringified.length; index += 1) {
      stringified[index] = `${indent}${stringified[index]}`;
    }
  }
  stringified[0] = `${indent}${key}: ${stringified[0]}`;
  return stringified.join('\n');
}

function stringifyObjectMember(member: string, indent: string): string {
  const stringified = member.split('\n');
  stringified[stringified.length - 1] = `${stringified.at(-1)},`;
  for (const [index, line] of stringified.entries()) {
    stringified[index] = `${indent}${line}`;
  }
  return stringified.join('\n');
}
