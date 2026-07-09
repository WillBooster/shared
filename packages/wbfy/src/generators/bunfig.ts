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
  };
  run?: {
    bun?: boolean;
  };
}

export const bunMinimumReleaseAgeSeconds = 432_000;
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
  '@typescript/typescript-darwin-arm64',
  '@typescript/typescript-darwin-x64',
  '@typescript/typescript-linux-arm',
  '@typescript/typescript-linux-arm64',
  '@typescript/typescript-linux-x64',
  // Bun itself releases its first-party type packages in lockstep with the
  // runtime, so generated Bun repos must be able to install them immediately.
  '@types/bun',
  'bun-types',
  'oxfmt',
  '@oxfmt/binding-android-arm-eabi',
  '@oxfmt/binding-android-arm64',
  '@oxfmt/binding-darwin-arm64',
  '@oxfmt/binding-darwin-x64',
  '@oxfmt/binding-freebsd-x64',
  '@oxfmt/binding-linux-arm-gnueabihf',
  '@oxfmt/binding-linux-arm-musleabihf',
  '@oxfmt/binding-linux-arm64-gnu',
  '@oxfmt/binding-linux-arm64-musl',
  '@oxfmt/binding-linux-ppc64-gnu',
  '@oxfmt/binding-linux-riscv64-gnu',
  '@oxfmt/binding-linux-riscv64-musl',
  '@oxfmt/binding-linux-s390x-gnu',
  '@oxfmt/binding-linux-x64-gnu',
  '@oxfmt/binding-linux-x64-musl',
  '@oxfmt/binding-openharmony-arm64',
  '@oxfmt/binding-win32-arm64-msvc',
  '@oxfmt/binding-win32-ia32-msvc',
  '@oxfmt/binding-win32-x64-msvc',
  'oxlint',
  '@oxlint/binding-android-arm-eabi',
  '@oxlint/binding-android-arm64',
  '@oxlint/binding-darwin-arm64',
  '@oxlint/binding-darwin-x64',
  '@oxlint/binding-freebsd-x64',
  '@oxlint/binding-linux-arm-gnueabihf',
  '@oxlint/binding-linux-arm-musleabihf',
  '@oxlint/binding-linux-arm64-gnu',
  '@oxlint/binding-linux-arm64-musl',
  '@oxlint/binding-linux-ppc64-gnu',
  '@oxlint/binding-linux-riscv64-gnu',
  '@oxlint/binding-linux-riscv64-musl',
  '@oxlint/binding-linux-s390x-gnu',
  '@oxlint/binding-linux-x64-gnu',
  '@oxlint/binding-linux-x64-musl',
  '@oxlint/binding-openharmony-arm64',
  '@oxlint/binding-win32-arm64-msvc',
  '@oxlint/binding-win32-ia32-msvc',
  '@oxlint/binding-win32-x64-msvc',
  'oxlint-tsgolint',
  '@oxlint-tsgolint/darwin-arm64',
  '@oxlint-tsgolint/darwin-x64',
  '@oxlint-tsgolint/linux-arm64',
  '@oxlint-tsgolint/linux-x64',
  '@oxlint-tsgolint/win32-arm64',
  '@oxlint-tsgolint/win32-x64',
  '@next/env',
  '@next/font',
  '@next/rspack-binding-linux-arm64-gnu',
  '@next/rspack-binding-linux-arm64-musl',
  '@next/rspack-binding-linux-x64-gnu',
  '@next/rspack-binding-linux-x64-musl',
  '@next/swc-android-arm-eabi',
  '@next/swc-android-arm64',
  '@next/swc-darwin-arm64',
  '@next/swc-darwin-x64',
  '@next/swc-freebsd-x64',
  '@next/swc-linux-arm-gnueabihf',
  '@next/swc-linux-arm64-gnu',
  '@next/swc-linux-arm64-musl',
  '@next/swc-linux-x64-gnu',
  '@next/swc-linux-x64-musl',
  '@next/swc-wasm-nodejs',
  '@next/swc-wasm-web',
  '@next/third-parties',
  'next',
  'react',
  'react-dom',
];

export async function generateBunfigToml(config: PackageConfig): Promise<void> {
  return logger.functionIgnoringException('generateBunfigToml', async () => {
    const filePath = path.resolve(config.dirPath, 'bunfig.toml');
    const existingContent = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : undefined;
    const content = newContent(existingContent);
    await promisePool.run(() => fsUtil.generateFile(filePath, content));
  });
}

const newContent = (existingContent: string | undefined): string => {
  const bunfigToml = parseBunfigToml(existingContent);
  return `env = false
telemetry = false

${generateRunSection(bunfigToml)}
[install]
exact = ${bunfigToml?.install?.exact === false ? 'false' : 'true'}
linker = "hoisted"
minimumReleaseAge = ${bunMinimumReleaseAgeSeconds} # 5 days
minimumReleaseAgeExcludes = [
${bunMinimumReleaseAgeExcludes.map((packageName) => `    "${packageName}",`).join('\n')}
]
`;
};

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

function generateRunSection(bunfigToml: BunfigToml | undefined): string {
  return typeof bunfigToml?.run?.bun === 'boolean' ? `[run]\nbun = ${bunfigToml.run.bun}\n` : '';
}
