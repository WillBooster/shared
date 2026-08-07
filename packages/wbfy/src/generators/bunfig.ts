import fs from 'node:fs';
import path from 'node:path';

import { parse } from 'smol-toml';

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
    minimumReleaseAge?: number;
  };
}

export const bunMinimumReleaseAgeSeconds = 604_800;

// Only our own packages are exempt from the minimum release age: we control who publishes them,
// so a compromised release cannot reach us through an upstream maintainer's stolen credentials.
// Third-party packages — including tooling wbfy pins itself — stay age-gated;
// getLatestAgeGatedDependencyVersion in packageJson.ts pins the newest release old enough to pass
// the gate, so pinning keeps working without an exemption.
export const bunMinimumReleaseAgeExcludes = [
  '@exercode/problem-utils',
  '@willbooster-private/agentic-workflows',
  '@willbooster-private/llm-proxy',
  '@willbooster/agent-skills',
  '@willbooster/babel-configs',
  '@willbooster/monaco-loader',
  '@willbooster/monaco-react',
  '@willbooster/oxfmt-config',
  '@willbooster/oxlint-config',
  '@willbooster/prettier-config',
  '@willbooster/react-frame-component',
  '@willbooster/shared-lib',
  '@willbooster/shared-lib-blitz-next',
  '@willbooster/shared-lib-next',
  '@willbooster/shared-lib-node',
  '@willbooster/shared-lib-react',
  '@willbooster/wb',
  'agent-runtime-kit',
  'at-decorators',
  'build-ts',
  'gen-i18n-ts',
  'one-way-git-sync',
  'vinext-progress',
];

export function readBunGlobalStore(rootDirPath: string): boolean | undefined {
  const filePath = path.resolve(rootDirPath, 'bunfig.toml');
  if (!fs.existsSync(filePath)) return undefined;
  return parseBunfigToml(fs.readFileSync(filePath, 'utf8'))?.install?.globalStore;
}

/**
 * The minimum release age Bun enforces in `rootDirPath`, in seconds: the repository-specific
 * override newContent preserves, or the org default when the repository has none.
 */
export function readBunMinimumReleaseAgeSeconds(rootDirPath: string): number {
  const filePath = path.resolve(rootDirPath, 'bunfig.toml');
  if (!fs.existsSync(filePath)) return bunMinimumReleaseAgeSeconds;
  return parseBunfigToml(fs.readFileSync(filePath, 'utf8'))?.install?.minimumReleaseAge ?? bunMinimumReleaseAgeSeconds;
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
  return !configs.some((config) => config.depending.next || config.depending.blitz);
}

export async function generateBunfigToml(config: PackageConfig, useGlobalStore: boolean): Promise<void> {
  return logger.functionIgnoringException('generateBunfigToml', async () => {
    const filePath = path.resolve(config.dirPath, 'bunfig.toml');
    const existingContent = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : undefined;
    const content = newContent(existingContent, config, useGlobalStore);
    await promisePool.run(() => fsUtil.generateFile(filePath, content));
  });
}

const newContent = (existingContent: string | undefined, config: PackageConfig, useGlobalStore: boolean): string => {
  const bunfigToml = parseBunfigToml(existingContent);
  // Only Java repositories still depend on @willbooster/prettier-config (wbfy installs it with
  // prettier-plugin-java); everywhere else oxfmt replaced Prettier, so the exclusion is dead
  // weight in the generated file. The exported list keeps the entry because packageJson.ts's
  // version age gate matters only where wbfy actually pins the package (i.e. Java repositories).
  const managedExcludes = doesContainJava(config)
    ? bunMinimumReleaseAgeExcludes
    : bunMinimumReleaseAgeExcludes.filter((packageName) => packageName !== '@willbooster/prettier-config');
  // minimumReleaseAgeExcludes is org policy, never repository policy: every entry comes from
  // bunMinimumReleaseAgeExcludes, and any hand-added (or previously migrated) repository-specific
  // entry is dropped on regeneration. Dropping is fail-safe — an uncovered package becomes
  // age-gated and surfaces at install time instead of weakening the gate. A repository that
  // genuinely needs an exclusion must add it to bunMinimumReleaseAgeExcludes in wbfy so all
  // repositories share the same vetted list. The custom npmMinimalAgeGate (or an
  // already-customized minimumReleaseAge) is still carried over — only the excludes are locked.
  const minimumReleaseAgeSeconds = bunfigToml?.install?.minimumReleaseAge ?? bunMinimumReleaseAgeSeconds;
  // Turbopack rejects global-store symlinks because they resolve outside its filesystem root.
  // Keeping Next.js installs project-local avoids widening that root to $HOME (or `/` in Docker),
  // which would expand development filesystem watching and bypass the boundary's cache benefits.
  const globalStoreLine = useGlobalStore
    ? 'globalStore = true'
    : '# Keep Turbopack dependencies inside the project root.\nglobalStore = false';
  // No `[run] bun = true`: its node->bun PATH shim leaks into every child process and breaks
  // tools requiring real Node.js (Playwright, wrangler, vinext); any existing setting is dropped.
  // publicHoistPattern — tsx: build-ts under Node.js spawns `node --import tsx`, which resolves
  // tsx from the consumer package's directory, not from build-ts's own dependencies.
  // undici-types: bun-types references it without declaring it as a dependency (oven-sh/bun#22805);
  // generated tsconfigs also map undici-types to the hoisted copy (see tsconfig.ts) because the
  // global store realpaths bun-types outside the repository.
  return `env = false
telemetry = false

${extractRawTestSections(existingContent)}[install]
exact = ${bunfigToml?.install?.exact === false ? 'false' : 'true'}
${globalStoreLine}
linker = "isolated"
publicHoistPattern = ["tsx", "undici-types"]
minimumReleaseAge = ${minimumReleaseAgeSeconds}${minimumReleaseAgeSeconds === bunMinimumReleaseAgeSeconds ? ' # 7 days' : ` # repository-specific override (org default: ${bunMinimumReleaseAgeSeconds} = 7 days)`}
# minimumReleaseAgeExcludes is managed by wbfy — repository-specific entries are prohibited and
# removed on every run (the minimumReleaseAge above may still be repository-specific). To exclude
# a package, add it to bunMinimumReleaseAgeExcludes in WillBooster/shared
# (packages/wbfy/src/generators/bunfig.ts) so every repository shares the same vetted list.
minimumReleaseAgeExcludes = [
${managedExcludes.map((packageName) => `    "${packageName}",`).join('\n')}
]
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

function parseBunfigToml(content: string | undefined): BunfigToml | undefined {
  if (!content) {
    return undefined;
  }
  try {
    return parse(content) as BunfigToml;
  } catch {
    return undefined;
  }
}
