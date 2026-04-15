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

const minimumReleaseAgeExcludes = [
  '@exercode/problem-utils',
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
  '@willbooster/agent-skills',
  '@willbooster/babel-configs',
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
minimumReleaseAge = 432000 # 5 days
minimumReleaseAgeExcludes = [
${minimumReleaseAgeExcludes.map((packageName) => `    "${packageName}",`).join('\n')}
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
