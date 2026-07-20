import fs from 'node:fs';
import path from 'node:path';

import { parse } from 'smol-toml';

import { logger } from '../logger.js';
import type { PackageConfig } from '../packageConfig.js';
import { isLiteralNpmPackageName, type YarnReleaseAgeSettings } from './removeYarnFiles.js';
import { fsUtil } from '../utils/fsUtil.js';
import { doesContainJava } from '../utils/packageCapabilities.js';
import { promisePool } from '../utils/promisePool.js';

interface BunfigToml {
  install?: {
    exact?: boolean;
    linker?: string;
    minimumReleaseAge?: number;
  };
}

// Everything after this marker inside minimumReleaseAgeExcludes is repository policy (e.g.
// migrated from .yarnrc.yml npmPreapprovedPackages) and is preserved across regenerations.
const repoSpecificExcludesMarker = '    # ---------- repository-specific entries ----------';

export const bunMinimumReleaseAgeSeconds = 432_000;

// Platform sets must match each package's optionalDependencies on npm because
// Bun checks all platform binaries in the lockfile, not just the current one.
// Keep win32 entries even though we drop Windows support: omitting any
// platform makes `bun add` fail until the minimum-release-age window elapses.
const typescriptPlatforms = [
  'aix-ppc64',
  'darwin-arm64',
  'darwin-x64',
  'freebsd-arm64',
  'freebsd-x64',
  'linux-arm',
  'linux-arm64',
  'linux-loong64',
  'linux-mips64el',
  'linux-ppc64',
  'linux-riscv64',
  'linux-s390x',
  'linux-x64',
  'netbsd-arm64',
  'netbsd-x64',
  'openbsd-arm64',
  'openbsd-x64',
  'sunos-x64',
  'win32-arm64',
  'win32-x64',
];
const oxcBindingPlatforms = [
  'android-arm-eabi',
  'android-arm64',
  'darwin-arm64',
  'darwin-x64',
  'freebsd-x64',
  'linux-arm-gnueabihf',
  'linux-arm-musleabihf',
  'linux-arm64-gnu',
  'linux-arm64-musl',
  'linux-ppc64-gnu',
  'linux-riscv64-gnu',
  'linux-riscv64-musl',
  'linux-s390x-gnu',
  'linux-x64-gnu',
  'linux-x64-musl',
  'openharmony-arm64',
  'win32-arm64-msvc',
  'win32-ia32-msvc',
  'win32-x64-msvc',
];
const tsgolintPlatforms = ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'win32-arm64', 'win32-x64'];
const nextRspackPlatforms = [
  'android-arm-eabi',
  'android-arm64',
  'darwin-arm64',
  'darwin-x64',
  'linux-arm-gnueabihf',
  'linux-arm64-gnu',
  'linux-arm64-musl',
  'linux-x64-gnu',
  'linux-x64-musl',
  'win32-arm64-msvc',
  'win32-ia32-msvc',
  'win32-x64-msvc',
];
const nextSwcPlatforms = [
  'android-arm-eabi',
  'android-arm64',
  'darwin-arm64',
  'darwin-x64',
  'freebsd-x64',
  'linux-arm-gnueabihf',
  'linux-arm64-gnu',
  'linux-arm64-musl',
  'linux-x64-gnu',
  'linux-x64-musl',
  'wasm-nodejs',
  'wasm-web',
  'win32-arm64-msvc',
  'win32-ia32-msvc',
  'win32-x64-msvc',
];

export const bunMinimumReleaseAgeExcludes = [
  // ---------- START: We believe our packages are safe ----------
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
  '@willbooster/renovate-config',
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
  // ---------- END: We believe our packages are safe ----------

  // wbfy pins these tooling packages and may apply them immediately after a
  // release, before the global minimum-release-age window has elapsed.
  'typescript',
  ...typescriptPlatforms.map((platform) => `@typescript/typescript-${platform}`),
  // Bun itself releases its first-party type packages in lockstep with the
  // runtime, so generated Bun repos must be able to install them immediately.
  '@types/bun',
  'bun-types',
  'oxfmt',
  ...oxcBindingPlatforms.map((platform) => `@oxfmt/binding-${platform}`),
  'oxlint',
  ...oxcBindingPlatforms.map((platform) => `@oxlint/binding-${platform}`),
  'oxlint-tsgolint',
  ...tsgolintPlatforms.map((platform) => `@oxlint-tsgolint/${platform}`),
  '@next/env',
  '@next/font',
  '@next/rspack-binding',
  ...nextRspackPlatforms.map((platform) => `@next/rspack-binding-${platform}`),
  ...nextSwcPlatforms.map((platform) => `@next/swc-${platform}`),
  '@next/third-parties',
  'next',
  'react',
  'react-dom',
  // Repos pin react-is via resolutions in lockstep with react, so a fresh react release must
  // resolve immediately like react/react-dom above.
  'react-is',
  // vinext is still pre-1.0 and its scoped packages release in lockstep, so the whole
  // set must be listed: excluding only `vinext` still fails because Bun gates the
  // transitive `@vinext/types`. Bun matches these names literally, so `@vinext/*`
  // would not work here even though wbfy's own pattern matcher accepts globs.
  '@vinext/cloudflare',
  '@vinext/types',
  'vinext',
];

export type BunLinker = 'isolated' | 'hoisted';

/**
 * Reads the linker explicitly declared in the repository's bunfig.toml. Returns undefined when
 * none is declared: Bun's default is context-dependent (isolated for new workspace projects with
 * `configVersion = 1` lockfiles, hoisted otherwise), so absence must not be read as hoisted.
 */
export function readBunLinker(rootDirPath: string): BunLinker | undefined {
  const filePath = path.resolve(rootDirPath, 'bunfig.toml');
  if (!fs.existsSync(filePath)) return undefined;
  const linker = parseBunfigToml(fs.readFileSync(filePath, 'utf8'))?.install?.linker;
  return linker === 'isolated' || linker === 'hoisted' ? linker : undefined;
}

export async function generateBunfigToml(
  config: PackageConfig,
  linker: BunLinker = 'isolated',
  yarnReleaseAgeSettings?: YarnReleaseAgeSettings
): Promise<void> {
  return logger.functionIgnoringException('generateBunfigToml', async () => {
    const filePath = path.resolve(config.dirPath, 'bunfig.toml');
    const existingContent = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : undefined;
    const content = newContent(existingContent, linker, config, yarnReleaseAgeSettings);
    await promisePool.run(() => fsUtil.generateFile(filePath, content));
  });
}

const newContent = (
  existingContent: string | undefined,
  linker: BunLinker,
  config: PackageConfig,
  yarnReleaseAgeSettings?: YarnReleaseAgeSettings
): string => {
  const bunfigToml = parseBunfigToml(existingContent);
  // Only Java repositories still depend on @willbooster/prettier-config (wbfy installs it with
  // prettier-plugin-java); everywhere else oxfmt replaced Prettier, so the exclusion is dead
  // weight in the generated file. The exported list keeps the entry because packageJson.ts's
  // version age gate matters only where wbfy actually pins the package (i.e. Java repositories).
  const managedExcludes = doesContainJava(config)
    ? bunMinimumReleaseAgeExcludes
    : bunMinimumReleaseAgeExcludes.filter((packageName) => packageName !== '@willbooster/prettier-config');
  // The repository's own release-age policy must survive every run, not just the migration one:
  // repo-specific npmPreapprovedPackages entries (pre-filtered to literal names — Bun matches
  // these literally) AND the entries under the repository-specific marker of the existing
  // bunfig.toml are merged after the managed list, and a custom npmMinimalAgeGate (or an
  // already-customized minimumReleaseAge) is carried over. Only marker-tagged entries count as
  // repo-specific — provenance stays explicit in the file itself, so entries an older wbfy
  // version managed and later retired can never masquerade as repository policy. An explicit
  // repository preapproval that ALSO appears in the managed list is emitted once, under the
  // marker: the effective exclusion set is identical, but the repository-policy provenance
  // survives even if wbfy later retires that managed entry.
  const repoSpecificExcludes = [
    ...new Set([
      ...(yarnReleaseAgeSettings?.minimumReleaseAgeExcludes ?? []),
      ...readRepoSpecificExcludes(existingContent),
    ]),
  ].toSorted();
  const repoSpecificExcludeSet = new Set(repoSpecificExcludes);
  const minimumReleaseAgeExcludes = [
    ...managedExcludes
      .filter((packageName) => !repoSpecificExcludeSet.has(packageName))
      .map((packageName) => `    "${packageName}",`),
    ...(repoSpecificExcludes.length > 0
      ? [repoSpecificExcludesMarker, ...repoSpecificExcludes.map((packageName) => `    "${packageName}",`)]
      : []),
  ];
  const minimumReleaseAgeSeconds =
    yarnReleaseAgeSettings?.minimumReleaseAgeSeconds ??
    bunfigToml?.install?.minimumReleaseAge ??
    bunMinimumReleaseAgeSeconds;
  // No `[run] bun = true`: its node->bun PATH shim leaks into every child process and breaks
  // tools requiring real Node.js (Playwright, wrangler, vinext); any existing setting is dropped.
  return `env = false
telemetry = false

${extractRawTestSections(existingContent)}[install]
exact = ${bunfigToml?.install?.exact === false ? 'false' : 'true'}
${
  linker === 'isolated'
    ? // tsx: build-ts under Node.js spawns `node --import tsx`, which resolves tsx from the
      // consumer package's directory, not from build-ts's own dependencies.
      // undici-types: bun-types references it without declaring it as a dependency
      // (oven-sh/bun#22805); generated tsconfigs also map undici-types to the hoisted copy
      // (see tsconfig.ts) because the global store realpaths bun-types outside the repository.
      'globalStore = true\nlinker = "isolated"\npublicHoistPattern = ["tsx", "undici-types"]'
    : 'linker = "hoisted"'
}
minimumReleaseAge = ${minimumReleaseAgeSeconds}${minimumReleaseAgeSeconds === bunMinimumReleaseAgeSeconds ? ' # 5 days' : ` # repository-specific override (org default: ${bunMinimumReleaseAgeSeconds} = 5 days)`}
minimumReleaseAgeExcludes = [
${minimumReleaseAgeExcludes.join('\n')}
]
`;
};

function readRepoSpecificExcludes(content: string | undefined): string[] {
  if (!content) return [];
  const lines = content.split('\n');
  const markerIndex = lines.findIndex((line) => line.trim() === repoSpecificExcludesMarker.trim());
  if (markerIndex === -1) return [];
  const excludes: string[] = [];
  for (const line of lines.slice(markerIndex + 1)) {
    const trimmed = line.trim();
    // The section ends at the array's closing bracket; hand-added comments and blank lines
    // between entries must not truncate the repository-policy list (though only the entries
    // themselves survive regeneration).
    if (trimmed.startsWith(']')) break;
    if (!trimmed || trimmed.startsWith('#')) continue;
    // wbfy writes one double-quoted entry per line. A line this parser cannot read could hide
    // further entries, so stop instead of guessing.
    const entry = /^"([^"]+)",?$/u.exec(trimmed)?.[1];
    if (!entry) break;
    // Hand-edited entries pass the same strict name gate as migrated ones: anything else would
    // be dead configuration for Bun and could even break the generated TOML when interpolated.
    if (isLiteralNpmPackageName(entry)) excludes.push(entry);
  }
  return excludes;
}

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
