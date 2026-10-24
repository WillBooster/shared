import fs from 'node:fs';
import path from 'node:path';

import releaseAgeGate from '../../configs/releaseAgeGate.json' with { type: 'json' };
import { logger } from '../logger.js';
import type { PackageConfig } from '../packageConfig.js';
import { fsUtil } from '../utils/fsUtil.js';
import { doesContainJava } from '../utils/packageCapabilities.js';
import { promisePool } from '../utils/promisePool.js';

interface BunfigToml {
  install?: {
    exact?: boolean;
    globalStore?: boolean;
    linker?: string;
    minimumReleaseAgeExcludes?: string[];
  };
}

// configs/releaseAgeGate.json is the organization's single source of truth for the policy: the
// machines' global configs get it through configs/applyReleaseAgeGate.sh (run by wbfy itself, by
// reusable-workflows on CI, and by self-host-utils on the runners), and repositories get it here.
// Our own packages are exempt: we control who publishes them, so a compromised release cannot
// reach us through an upstream maintainer's stolen credentials. That covers every
// @willbooster-private package (the scope resolves only from our own registry), but bun, npm, and
// Yarn match exclude entries by exact name — no @scope/* patterns — so each new package in the
// scope must be added to configs/releaseAgeGate.json when it is first published. The only permanent
// third-party exemption is the Codex CLI, whose newest models run only on its latest releases.
// Other third-party packages — including tooling wbfy pins itself — stay age-gated;
// getLatestAgeGatedDependencyVersion in packageJson.ts pins the newest release old enough to pass
// the gate, so pinning keeps working without an exemption. `temporaryExcludes` lets a third-party
// release needed now (a security fix, or an SDK a new model requires) in immediately and gates the
// package again from the given UTC date, so the next wbfy run restores the gate without anyone
// having to remember to remove the entry. List every package that release pins exactly and
// publishes alongside it, since exclusion matches exact names only.
export const bunMinimumReleaseAgeSeconds = releaseAgeGate.days * 24 * 60 * 60;
const today = new Date().toISOString().slice(0, 10);
export const bunMinimumReleaseAgeExcludes = [
  ...releaseAgeGate.excludes,
  ...Object.entries(releaseAgeGate.temporaryExcludes)
    .filter(([, gatedAgainFrom]) => today < gatedAgainFrom)
    .map(([packageName]) => packageName),
];

/**
 * Whether the repository's bunfig.toml lists today's exemptions. `temporaryExcludes` changes them by
 * date alone, so a repository already configured by the running wbfy build must not be skipped
 * once they differ, or an expired exemption would outlive its date.
 */
export function hasCurrentBunReleaseAgeExcludes(rootDirPath: string): boolean {
  const filePath = path.resolve(rootDirPath, 'bunfig.toml');
  if (!fs.existsSync(filePath)) return true;
  const excludes = parseBunfigToml(fs.readFileSync(filePath, 'utf8'))?.install?.minimumReleaseAgeExcludes;
  return excludes?.join('\n') === bunMinimumReleaseAgeExcludes.join('\n');
}

export function readBunGlobalStore(rootDirPath: string): boolean | undefined {
  const filePath = path.resolve(rootDirPath, 'bunfig.toml');
  if (!fs.existsSync(filePath)) return undefined;
  return parseBunfigToml(fs.readFileSync(filePath, 'utf8'))?.install?.globalStore;
}

export function resolveBunGlobalStore(
  configs: PackageConfig[],
  previousGlobalStore: boolean | undefined,
  skipDeps: boolean
): boolean {
  const defaultUseGlobalStore = shouldUseBunGlobalStore(configs);
  return skipDeps ? (previousGlobalStore ?? defaultUseGlobalStore) : defaultUseGlobalStore;
}

export function shouldUseBunGlobalStore(configs: PackageConfig[]): boolean {
  // Blitz builds on Next.js but need not declare it directly, and its codegen also patches Next
  // inside node_modules. Both frameworks therefore require project-local isolated installs.
  // Slidev loads optional Vue compiler peers through local-pkg. The global store realpaths
  // local-pkg outside the project, so Node cannot resolve a compiler declared by the project.
  return !configs.some((config) => config.depending.next || config.depending.blitz || config.depending.slidev);
}

export async function generateBunfigToml(
  config: PackageConfig,
  useGlobalStore: boolean,
  allConfigs: PackageConfig[] = [config]
): Promise<void> {
  return logger.functionIgnoringException('generateBunfigToml', async () => {
    const filePath = path.resolve(config.dirPath, 'bunfig.toml');
    const existingContent = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : undefined;
    const usesPrettierConfig = allConfigs.some(
      (packageConfig) =>
        doesContainJava(packageConfig) ||
        fs.existsSync(path.join(packageConfig.dirPath, '.prettierrc.json')) ||
        Boolean(packageConfig.packageJson?.prettier)
    );
    const existingIgnoreLines = extractProjectFmtIgnoreLines(existingContent);
    const projectIgnoreLines = (
      existingIgnoreLines.length > 0 ? existingIgnoreLines : migrateOxfmtIgnoreLines(config.dirPath)
    ).filter((line) => !fmtIgnorePatterns.some((pattern) => line === `"${pattern}",`));
    const content = newContent(existingContent, useGlobalStore, usesPrettierConfig, projectIgnoreLines);
    await promisePool.runAndWaitForReturnValue(() => fsUtil.generateFile(filePath, content));
  });
}

const fmtIgnorePatterns = [
  '**/.agents/**',
  '**/.claude/**',
  '**/.devcontainer/**',
  '**/.idea/AugmentWebviewStateStore.xml',
  '**/.idea/copilot*/**',
  '**/.playwright-cli/**',
  '**/.serena/**',
  '**/.tmp/**',
  '**/.venv/**',
  '**/.yarn/**',
  '**/3rd-party/**',
  '**/@types/**',
  '**/@willbooster/**',
  '**/__generated__/**',
  '**/android/**',
  '**/bin/**',
  '**/build/**',
  '**/coverage/**',
  '**/dist/**',
  '**/ios/**',
  '**/no-format/**',
  '**/node_modules/**',
  '**/temp/**',
  '**/tmp/**',
  '**/test-fixtures/**',
  '**/test-results/**',
  '**/test/fixtures/**',
  '**/.aider*',
  '**/.env.production',
  '**/.pnp.js',
  '**/*/mount/*.hash',
  '**/*.d.ts',
  // Prettier formats Java; `bun fmt` would run it a second time through a Prettier config's plugin.
  '**/*.java',
  '**/*.min.*js',
  // Tree-sitter owns these JSON files' layout, including their missing final newline.
  // Formatting them makes a subsequent `tree-sitter generate` dirty the working tree.
  '**/src/grammar.json',
  '**/src/node-types.json',
];

// Lines below this comment in `ignorePatterns` belong to the repository and survive regeneration.
const projectIgnorePatternsComment = '# Project-specific patterns';

const newContent = (
  existingContent: string | undefined,
  useGlobalStore: boolean,
  usesPrettierConfig: boolean,
  projectIgnoreLines: string[]
): string => {
  const bunfigToml = parseBunfigToml(existingContent);
  // minimumReleaseAge and minimumReleaseAgeExcludes are org policy, never repository policy: both
  // are rewritten to configs/releaseAgeGate.json's values on every run, so a hand-edited (weakened)
  // gate cannot survive regeneration. Dropping repository-specific exclude entries is fail-safe — an
  // uncovered package becomes age-gated and surfaces at install time instead of weakening the gate.
  // Turbopack rejects global-store symlinks because they resolve outside its filesystem root.
  // Keeping Next.js installs project-local avoids widening that root to $HOME (or `/` in Docker),
  // which would expand development filesystem watching and bypass the boundary's cache benefits.
  const globalStoreLine = useGlobalStore ? 'globalStore = true' : 'globalStore = false';
  // A Prettier config makes Bun route TOML through Prettier, which has no TOML parser, even
  // with the oxfmt flavor selected. Java repositories receive that config on this same run.
  const ignorePatterns = usesPrettierConfig ? [...fmtIgnorePatterns, '**/*.toml'] : fmtIgnorePatterns;
  // No `[run] bun = true`: its node->bun PATH shim leaks into every child process and breaks
  // tools requiring real Node.js (Playwright, wrangler, vinext); any existing setting is dropped.
  // publicHoistPattern — tsx: build-ts under Node.js spawns `node --import tsx`, which resolves
  // tsx from the consumer package's directory, not from build-ts's own dependencies.
  // fmt overrides: sorting imports would move a repository's own imports into the managed blocks
  // of oxlint.config.ts, which wbfy replaces wholesale.
  // fmt flavor: oxfmt's output, which repositories already follow, differs from Prettier's in places
  // (e.g. long union types).
  return `env = false
telemetry = false

${extractRawTestSections(existingContent)}[install]
exact = ${bunfigToml?.install?.exact === false ? 'false' : 'true'}
${globalStoreLine}
linker = "isolated"
publicHoistPattern = ["tsx"]
minimumReleaseAge = ${bunMinimumReleaseAgeSeconds}
minimumReleaseAgeExcludes = [
${bunMinimumReleaseAgeExcludes.map((packageName) => `  "${packageName}",`).join('\n')}
]

[fmt]
flavor = "oxfmt"
printWidth = 120
singleQuote = true
sortImports = true
sortPackageJson = true
trailingComma = "es5"
ignorePatterns = [
${ignorePatterns.map((pattern) => `  "${pattern}",`).join('\n')}
${projectIgnoreLines.length > 0 ? `  ${projectIgnorePatternsComment}\n${projectIgnoreLines.map((line) => `  ${line}`).join('\n')}\n` : ''}]

[[fmt.overrides]]
files = ["**/oxlint.config.ts"]
options = { sortImports = false }
`;
};

/**
 * Preserve the project's `[test]` sections (e.g. preload scripts swapping a Cloudflare D1 client
 * for a local SQLite one) verbatim, comments included; wbfy manages only the other sections.
 */
export function extractRawTestSections(content: string | undefined): string {
  if (!content) return '';

  const preservedLines: string[] = [];
  let inTestSection = false;
  for (const line of content.split('\n')) {
    const sectionMatch = /^\s*\[([^\]]+)\]/.exec(line);
    if (sectionMatch) {
      inTestSection = sectionMatch[1] === 'test' || (sectionMatch[1] as string).startsWith('test.');
    }
    if (inTestSection && line.trim()) {
      preservedLines.push(line);
    }
  }
  return preservedLines.length > 0 ? `${preservedLines.join('\n')}\n\n` : '';
}

function extractProjectFmtIgnoreLines(content: string | undefined): string[] {
  const lines = content?.split('\n') ?? [];
  const startIndex = lines.findIndex((line) => line.trim() === projectIgnorePatternsComment);
  if (startIndex === -1) return [];
  const endIndex = lines.findIndex((line, index) => index > startIndex && line.trim() === ']');
  return lines
    .slice(startIndex + 1, endIndex === -1 ? undefined : endIndex)
    .map((line) => line.trim())
    .filter(Boolean);
}

/**
 * Convert the repository's own `ignorePatterns` in oxfmt.config.ts, which removeOxfmtConfig deletes
 * later in the same run, into bunfig.toml lines, keeping the comments that explain them.
 */
function migrateOxfmtIgnoreLines(dirPath: string): string[] {
  const migratedLines: string[] = [];
  let pendingComments: string[] = [];
  let inIgnorePatterns = false;
  for (const line of readOxfmtProjectSection(dirPath).split('\n')) {
    const { code, comment, patterns } = parseOxfmtConfigLine(line);
    if (comment !== undefined) pendingComments.push(`# ${comment}`.trimEnd());
    if (!code.trim()) continue;

    inIgnorePatterns ||= /\bignorePatterns\s*=/.test(code);
    const projectPatterns = patterns.filter((pattern) => !fmtIgnorePatterns.includes(pattern));
    if (inIgnorePatterns && projectPatterns.length > 0) {
      migratedLines.push(...pendingComments, ...projectPatterns.map((pattern) => `${JSON.stringify(pattern)},`));
    }
    // Comments above the assignment or its spread line describe the patterns that follow.
    if (!inIgnorePatterns || patterns.length > 0) pendingComments = [];
    // `...(oxfmtResolvedConfig.ignorePatterns ?? [])` contains a bracket, so only a closing one ends.
    if (/\]\s*;?\s*$/.test(code)) inIgnorePatterns = false;
  }
  return migratedLines;
}

function parseOxfmtConfigLine(line: string): { code: string; comment?: string; patterns: string[] } {
  // Matching string literals first keeps a `//` inside a pattern from starting a comment.
  const tokens = [...line.matchAll(/'([^']*)'|"([^"]*)"|\/\/\s?(.*)$/g)];
  const commentToken = tokens.find((token) => token[3] !== undefined);
  return {
    code: commentToken ? line.slice(0, commentToken.index) : line,
    comment: commentToken?.[3],
    patterns: tokens.flatMap((token) => (token[3] === undefined ? [token[1] ?? token[2] ?? ''] : [])),
  };
}

function readOxfmtProjectSection(dirPath: string): string {
  const filePath = path.resolve(dirPath, 'oxfmt.config.ts');
  if (!fs.existsSync(filePath)) return '';
  const content = fs.readFileSync(filePath, 'utf8');
  return /wbfy:end oxfmt-base([\s\S]*?)\/\/ wbfy:start oxfmt-export/.exec(content)?.[1] ?? '';
}

function parseBunfigToml(content: string | undefined): BunfigToml | undefined {
  if (!content) {
    return undefined;
  }
  try {
    return Bun.TOML.parse(content) as BunfigToml;
  } catch {
    return undefined;
  }
}
