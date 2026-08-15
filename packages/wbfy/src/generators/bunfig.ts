import fs from 'node:fs';
import path from 'node:path';

import { parse } from 'smol-toml';

import releaseAgeGate from '../../configs/releaseAgeGate.json' with { type: 'json' };
import { logger } from '../logger.js';
import type { PackageConfig } from '../packageConfig.js';
import { fsUtil } from '../utils/fsUtil.js';
import { promisePool } from '../utils/promisePool.js';

interface BunfigToml {
  install?: {
    exact?: boolean;
    globalStore?: boolean;
    linker?: string;
  };
}

// configs/releaseAgeGate.json is the organization's single source of truth for the policy: the
// machines' global configs get it through configs/applyReleaseAgeGate.sh (run by wbfy itself, by
// reusable-workflows on CI, and by self-host-utils on the runners), and repositories get it here.
// Only our own packages are exempt: we control who publishes them, so a compromised release cannot
// reach us through an upstream maintainer's stolen credentials. That covers every
// @willbooster-private package (the scope resolves only from our own registry), but bun, npm, and
// Yarn match exclude entries by exact name — no @scope/* patterns — so each new package in the
// scope must be added to configs/releaseAgeGate.json when it is first published. Third-party
// packages — including
// tooling wbfy pins itself — stay age-gated; getLatestAgeGatedDependencyVersion in packageJson.ts
// pins the newest release old enough to pass the gate, so pinning keeps working without an exemption.
export const bunMinimumReleaseAgeSeconds = releaseAgeGate.days * 24 * 60 * 60;
export const bunMinimumReleaseAgeExcludes = releaseAgeGate.excludes;

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
  return !configs.some((config) => config.depending.next || config.depending.blitz);
}

export async function generateBunfigToml(config: PackageConfig, useGlobalStore: boolean): Promise<void> {
  return logger.functionIgnoringException('generateBunfigToml', async () => {
    const filePath = path.resolve(config.dirPath, 'bunfig.toml');
    const existingContent = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : undefined;
    const content = newContent(existingContent, useGlobalStore);
    await promisePool.run(() => fsUtil.generateFile(filePath, content));
  });
}

const newContent = (existingContent: string | undefined, useGlobalStore: boolean): string => {
  const bunfigToml = parseBunfigToml(existingContent);
  // minimumReleaseAge and minimumReleaseAgeExcludes are org policy, never repository policy: both
  // are rewritten to configs/releaseAgeGate.json's values on every run, so a hand-edited (weakened)
  // gate cannot survive regeneration. Dropping repository-specific exclude entries is fail-safe — an
  // uncovered package becomes age-gated and surfaces at install time instead of weakening the gate.
  // Turbopack rejects global-store symlinks because they resolve outside its filesystem root.
  // Keeping Next.js installs project-local avoids widening that root to $HOME (or `/` in Docker),
  // which would expand development filesystem watching and bypass the boundary's cache benefits.
  const globalStoreLine = useGlobalStore ? 'globalStore = true' : 'globalStore = false';
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
minimumReleaseAge = ${bunMinimumReleaseAgeSeconds}
minimumReleaseAgeExcludes = [
${bunMinimumReleaseAgeExcludes.map((packageName) => `    "${packageName}",`).join('\n')}
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
