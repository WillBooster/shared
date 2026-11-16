import assert from 'node:assert';
import path from 'node:path';

import semver from 'semver';
import { parse as parseToml } from 'smol-toml';
import { z } from 'zod';

import type { PackageConfig } from '../packageConfig.js';
import { fsUtil } from '../utils/fsUtil.js';
import { spawnOrUndefined } from '../utils/spawnUtil.js';
import { setTomlTableString, setTomlTableValue } from '../utils/tomlUtil.js';
import { pinLatestToolVersion } from './miseToml.js';

export const minimumRustVersion = '1.100.0';

const rustOptionsSchema = z.object({
  profile: z.enum(['minimal', 'default', 'complete']).optional(),
  components: z.array(z.string()).optional(),
  targets: z.array(z.string()).optional(),
});
const miseRustSchema = z.preprocess(
  (value) => (typeof value === 'string' ? { version: value } : value),
  rustOptionsSchema.extend({ version: z.string() }).strict()
);
const toolchainSchema = z
  .object({ toolchain: rustOptionsSchema.extend({ channel: z.string() }) })
  .transform(({ toolchain: { channel, ...options } }) => ({ version: channel, ...options }));
const rustEnvironmentSchema = z.object({
  PATH: z.string(),
  RUSTUP_TOOLCHAIN: z.string(),
  RUSTUP_HOME: z.string().optional(),
  CARGO_HOME: z.string().optional(),
});

export async function generateRustToolchain(config: PackageConfig): Promise<string | undefined> {
  if (config.cargoTomlDirPaths.length === 0) return;

  const misePath = path.join(config.dirPath, 'mise.toml');
  const miseContent = (await fsUtil.readFileIfExists(misePath)) ?? '';
  const mise = z
    .object({ tools: z.object({ rust: miseRustSchema.optional() }).optional() })
    .parse(parseToml(miseContent));
  const toolchains = await readToolchains(config);
  const options = [
    mise.tools?.rust,
    ...toolchains.map(({ content }) => toolchainSchema.parse(parseToml(content))),
  ].filter((option) => option !== undefined);
  const versions = options.map((option) => option.version).filter((version) => semver.valid(version));
  const version = z
    .string()
    .parse(await pinLatestToolVersion('rust', semver.rsort(versions)[0], config.dirPath, minimumRustVersion));
  const profiles = ['minimal', 'default', 'complete'] as const;
  const profile =
    profiles.toReversed().find((candidate) => options.some((option) => option.profile === candidate)) ?? 'minimal';
  const components = [
    ...new Set(['clippy', 'rustfmt', ...options.flatMap((option) => option.components ?? [])]),
  ].toSorted();
  const targets = [...new Set(options.flatMap((option) => option.targets ?? []))].toSorted();
  const writes = [
    {
      filePath: misePath,
      content: setTomlTableValue(miseContent, 'tools', 'rust', {
        version,
        profile,
        components,
        ...(targets.length > 0 ? { targets } : {}),
      }),
    },
    ...toolchains.map(({ filePath, content }) => ({
      filePath,
      content: setTomlTableString(content, 'toolchain', 'channel', version),
    })),
  ];
  for (const { filePath } of writes) {
    assert.ok(await fsUtil.isConfinedWritablePath(filePath), `Cannot update Rust configuration: ${filePath}`);
  }
  for (const { filePath, content } of writes) {
    assert.ok(await fsUtil.generateFile(filePath, content), `Cannot update Rust configuration: ${filePath}`);
  }
  return version;
}

export async function activateRustToolchain(config: PackageConfig, version: string): Promise<boolean> {
  const result = await spawnOrUndefined('mise', ['env', '--json'], { cwd: config.dirPath, env: process.env });
  if (result?.status !== 0) {
    console.error(`Cannot activate Rust ${version}: ${result?.stderr ?? 'mise could not be started'}`);
    return false;
  }
  const env = rustEnvironmentSchema.parse(JSON.parse(result.stdout));
  Object.assign(process.env, env);
  for (const dirPath of config.cargoTomlDirPaths) {
    const cwd = path.resolve(config.dirPath, dirPath);
    const cargo = await spawnOrUndefined('cargo', ['--version'], { cwd, env: process.env });
    if (cargo?.status !== 0 || cargo.stdout.split(' ')[1] !== version) {
      console.error(
        `Expected Cargo ${version} in ${cwd}; found ${cargo?.stdout.trim() ?? 'no executable'}. ${cargo?.stderr ?? ''}`
      );
      return false;
    }
  }
  return true;
}

async function readToolchains(config: PackageConfig): Promise<{ filePath: string; content: string }[]> {
  const directories = new Set([config.dirPath]);
  for (const cargoDirPath of config.cargoTomlDirPaths) {
    for (
      let dirPath = path.resolve(config.dirPath, cargoDirPath);
      dirPath !== config.dirPath;
      dirPath = path.dirname(dirPath)
    ) {
      directories.add(dirPath);
    }
  }
  const toolchains = [];
  for (const dirPath of directories) {
    const filePath = path.join(dirPath, 'rust-toolchain.toml');
    assert.ok(await fsUtil.isConfinedWritablePath(filePath), `Cannot update Rust configuration: ${filePath}`);
    const content = await fsUtil.readFileIfExists(filePath);
    if (content !== undefined) toolchains.push({ filePath, content });
  }
  return toolchains;
}
