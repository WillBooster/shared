import fs from 'node:fs';
import path from 'node:path';

import { parse } from 'smol-toml';

import { logger } from '../logger.js';
import type { PackageConfig } from '../packageConfig.js';
import { fsUtil } from '../utils/fsUtil.js';
import { promisePool } from '../utils/promisePool.js';

interface BunfigToml {
  install?: {
    exact?: boolean;
    linker?: string;
  };
}

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
  '@willbooster/agent-skills',
  '@willbooster/babel-configs',
  '@willbooster/monaco-loader',
  '@willbooster/monaco-react',
  '@willbooster/oxfmt-config',
  '@willbooster/oxlint-config',
  '@willbooster/prettier-config',
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

export async function generateBunfigToml(config: PackageConfig, linker: BunLinker = 'isolated'): Promise<void> {
  return logger.functionIgnoringException('generateBunfigToml', async () => {
    const filePath = path.resolve(config.dirPath, 'bunfig.toml');
    const existingContent = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : undefined;
    const content = newContent(existingContent, linker);
    await promisePool.run(() => fsUtil.generateFile(filePath, content));
  });
}

const newContent = (existingContent: string | undefined, linker: BunLinker): string => {
  const bunfigToml = parseBunfigToml(existingContent);
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
minimumReleaseAge = ${bunMinimumReleaseAgeSeconds} # 5 days
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
