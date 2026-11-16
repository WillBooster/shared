import { expect, test } from 'bun:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

import { spawnAsync } from '@willbooster/shared-lib-node/src';
import semver from 'semver';
import { z } from 'zod';

import {
  activateRustToolchain,
  generateRustToolchain,
  minimumRustVersion,
} from '../../src/generators/rustToolchain.js';
import { getPackageConfig } from '../../src/packageConfig.js';
import { fsUtil } from '../../src/utils/fsUtil.js';

const toolsSchema = z.object({
  tools: z.object({
    rust: z.object({
      version: z.string(),
      profile: z.string(),
      components: z.array(z.string()),
      targets: z.array(z.string()).optional(),
    }),
  }),
});

test('updates Rust pins together while preserving components, targets, and unrelated configuration', async () => {
  await withFixture(
    {
      'mise.toml':
        '# Keep this comment\n[tools]\nrust = { version = "1.101.0-beta.1", profile = "minimal", components = ["rust-src"] }\npython = "3.12.0"\n',
      'rust-toolchain.toml':
        '[toolchain]\nchannel = "1.101.0-beta.1" # pinned\nprofile = "minimal"\ncomponents = ["llvm-tools"]\n',
      'native/Cargo.toml': '[package]\nname = "example"\nversion = "0.1.0"\n',
      'native/rust-toolchain.toml': '[toolchain]\nchannel = "stable"\ntargets = ["wasm32-unknown-unknown"]\n',
    },
    async (dirPath) => {
      const config = await getPackageConfig(dirPath);
      assert.ok(config);
      const version = await generateRustToolchain(config);
      assert.ok(version);
      const content = fs.readFileSync(path.join(dirPath, 'mise.toml'), 'utf8');
      const { tools } = toolsSchema.parse(Bun.TOML.parse(content));
      expect(semver.gte(version, minimumRustVersion)).toBe(true);
      expect(semver.prerelease(version)).toBeNull();
      expect(tools.rust.version).toBe(version);
      expect(tools.rust.components).toEqual(['clippy', 'llvm-tools', 'rust-src', 'rustfmt']);
      expect(tools.rust.targets).toEqual(['wasm32-unknown-unknown']);
      expect(content).toContain('# Keep this comment\n');
      expect(content).toContain('python = "3.12.0"\n');
      expect(fs.readFileSync(path.join(dirPath, 'rust-toolchain.toml'), 'utf8')).toBe(
        `[toolchain]\nchannel = "${version}" # pinned\nprofile = "minimal"\ncomponents = ["llvm-tools"]\n`
      );
      expect(Bun.TOML.parse(fs.readFileSync(path.join(dirPath, 'native/rust-toolchain.toml'), 'utf8'))).toMatchObject({
        toolchain: { channel: version, targets: ['wasm32-unknown-unknown'] },
      });
      await generateRustToolchain(config);
      expect(fs.readFileSync(path.join(dirPath, 'mise.toml'), 'utf8')).toBe(content);

      const newer = semver.inc(version, 'patch')!;
      fs.writeFileSync(path.join(dirPath, 'native/rust-toolchain.toml'), `[toolchain]\nchannel = "${newer}"\n`);
      expect(await generateRustToolchain(config)).toBe(newer);
      expect(
        toolsSchema.parse(Bun.TOML.parse(fs.readFileSync(path.join(dirPath, 'mise.toml'), 'utf8'))).tools.rust.version
      ).toBe(newer);
    }
  );
}, 60_000);

test('rejects an uneditable toolchain without updating either pin', async () => {
  const mise = '[tools]\nrust = "1.99.1"\n';
  const toolchain = 'toolchain.channel = "1.99.1"\n';
  await withFixture({ 'mise.toml': mise, 'Cargo.toml': '', 'rust-toolchain.toml': toolchain }, async (dirPath) => {
    const config = await getPackageConfig(dirPath);
    assert.ok(config);
    const error: unknown = await generateRustToolchain(config).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toContain('Write channel as one');
    expect(fs.readFileSync(path.join(dirPath, 'mise.toml'), 'utf8')).toBe(mise);
    expect(fs.readFileSync(path.join(dirPath, 'rust-toolchain.toml'), 'utf8')).toBe(toolchain);
  });
}, 60_000);

test('leaves repositories without Cargo projects unchanged', async () => {
  const mise = '[tools]\npython = "3.12.0"\n';
  await withFixture({ 'mise.toml': mise }, async (dirPath) => {
    const config = await getPackageConfig(dirPath);
    assert.ok(config);
    expect(await generateRustToolchain(config)).toBeUndefined();
    expect(fs.readFileSync(path.join(dirPath, 'mise.toml'), 'utf8')).toBe(mise);
  });
});

test('installs and activates the generated Rust toolchain for Cargo and its components', async () => {
  await withFixture(
    {
      'mise.toml': '[tools]\nrust = "1.99.1"\n',
      'native/Cargo.toml': '[package]\nname = "example"\nversion = "0.1.0"\nedition = "2024"\n',
      'native/src/main.rs': 'fn main() {\n    println!("{}", env!("RUSTUP_TOOLCHAIN"));\n}\n',
    },
    async (dirPath) => {
      const config = await getPackageConfig(dirPath);
      assert.ok(config);
      const version = await generateRustToolchain(config);
      assert.ok(version);
      process.env.MISE_CEILING_PATHS = path.dirname(dirPath);
      process.env.MISE_CONFIG_DIR = path.join(dirPath, '.tmp/mise/config');
      process.env.MISE_GLOBAL_CONFIG_FILE = path.join(dirPath, '.tmp/mise/config/config.toml');
      process.env.MISE_DATA_DIR = path.join(dirPath, '.tmp/mise/data');
      process.env.MISE_STATE_DIR = path.join(dirPath, '.tmp/mise/state');
      process.env.RUSTUP_HOME = path.join(dirPath, '.tmp/rustup');
      process.env.CARGO_HOME = path.join(dirPath, '.tmp/cargo');
      process.env.MISE_PARANOID = '1';
      try {
        await run('mise', ['trust', path.join(dirPath, 'mise.toml')], dirPath);
        await run('mise', ['install', 'rust'], dirPath);
        expect(await activateRustToolchain(config, version)).toBe(true);
        await run('rustup', ['component', 'remove', '--toolchain', version, 'clippy', 'rustfmt'], dirPath);
        const misePath = path.join(dirPath, 'mise.toml');
        fs.writeFileSync(
          misePath,
          fs
            .readFileSync(misePath, 'utf8')
            .replace('profile = "minimal"', 'profile = "minimal", targets = ["wasm32-unknown-unknown"]')
        );
        await generateRustToolchain(config);
        await run('mise', ['trust', misePath], dirPath);
        await run('mise', ['install', 'rust'], dirPath);
        expect(await activateRustToolchain(config, version)).toBe(true);
        await run('cargo', ['check', '--target', 'wasm32-unknown-unknown'], path.join(dirPath, 'native'));
        const output = await run('cargo', ['run', '--quiet'], path.join(dirPath, 'native'));
        expect(output.trim().split('-')[0]).toBe(version);
        await run('cargo', ['fmt', '--all', '--check'], path.join(dirPath, 'native'));
        await run('cargo', ['clippy', '--', '-D', 'warnings'], path.join(dirPath, 'native'));
        expect(await activateRustToolchain(config, semver.inc(version, 'patch')!)).toBe(false);
      } finally {
        await spawnAsync('mise', ['untrust', path.join(dirPath, 'mise.toml')], { cwd: dirPath });
      }
    }
  );
}, 600_000);

async function withFixture(files: Record<string, string>, callback: (dirPath: string) => Promise<void>): Promise<void> {
  fs.mkdirSync('.tmp', { recursive: true });
  const dirPath = fs.realpathSync(fs.mkdtempSync(path.resolve('.tmp', 'wbfy-rust-')));
  const previousEnv = { ...process.env };
  try {
    fs.writeFileSync(path.join(dirPath, 'package.json'), '{}\n');
    for (const [name, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dirPath, name)), { recursive: true });
      fs.writeFileSync(path.join(dirPath, name), content);
    }
    await run('git', ['init', '--quiet'], dirPath);
    fsUtil.setRootDirPath(dirPath);
    await callback(dirPath);
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in previousEnv)) delete process.env[key];
    }
    Object.assign(process.env, previousEnv);
    fsUtil.setRootDirPath(undefined);
    fs.rmSync(dirPath, { recursive: true, force: true });
  }
}

async function run(command: string, args: string[], cwd: string): Promise<string> {
  const result = await spawnAsync(command, args, { cwd, env: process.env });
  expect(result.status, `${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`).toBe(0);
  return result.stdout;
}
