import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

import semver from 'semver';
import { parse as parseToml } from 'smol-toml';

import { logger } from '../logger.js';
import type { PackageConfig } from '../packageConfig.js';
import { fsUtil } from '../utils/fsUtil.js';
import { spawnAndReturnStdout } from '../utils/spawnUtil.js';
import { setTomlTableString } from '../utils/tomlUtil.js';

interface MiseToml {
  tools?: Record<string, unknown>;
}

// The oldest Bun runtime wbfy supports: the generated scripts and hooks run `bun fmt`, added in 1.4.4.
export const minimumBunVersion = '1.4.4';

// Pinned even while `mise latest` still hides it behind its release-age filter.
export const minimumPinnedBunVersion = '1.4.4';

export const minimumPinnedNodeVersion = '26.13.0';

export async function generateMiseToml(config: PackageConfig): Promise<void> {
  return logger.functionIgnoringException('generateMiseToml', async () => {
    const miseTomlPath = path.resolve(config.dirPath, 'mise.toml');
    const content = readMiseToml(miseTomlPath);
    // A parse failure must abort: editing pins in a broken mise.toml would hide the breakage.
    const tools = (parseToml(content) as MiseToml).tools ?? {};

    const pins: Record<string, unknown> = {
      node: await pinLatestToolVersion(
        `node@${semver.major(minimumPinnedNodeVersion)}`,
        tools.node,
        config.dirPath,
        minimumPinnedNodeVersion
      ),
      bun: await pinLatestToolVersion('bun', tools.bun, config.dirPath, minimumPinnedBunVersion),
    };
    if (fs.existsSync(path.resolve(config.dirPath, 'fnox.toml'))) {
      pins.fnox = await pinLatestToolVersion('fnox', tools.fnox, config.dirPath);
    }

    let newContent = content;
    for (const [tool, version] of Object.entries(pins)) {
      if (version === tools[tool]) continue;
      assert.ok(typeof version === 'string', `The resolved ${tool} pin must be a version string.`);
      newContent = setTomlTableString(newContent, 'tools', tool, version);
    }
    await fsUtil.generateFile(miseTomlPath, newContent);
  });
}

async function pinLatestToolVersion(
  tool: string,
  version: unknown,
  cwd: string,
  minimumVersion?: string
): Promise<unknown> {
  // Resolve independently of the target's trust state and tool aliases.
  const resolvedVersion = await spawnAndReturnStdout('mise', ['--no-config', 'latest', tool], cwd);
  // A cached release listing can lag behind another machine that already updated the pin.
  const candidates = [resolvedVersion, version, minimumVersion].filter(
    (candidate): candidate is string => typeof candidate === 'string' && semver.valid(candidate) !== null
  );
  return semver.rsort(candidates)[0] ?? version ?? 'latest';
}

function readMiseToml(miseTomlPath: string): string {
  try {
    return fs.readFileSync(miseTomlPath, 'utf8');
  } catch (error) {
    // Only a repository without mise.toml starts from an empty configuration; an unreadable file
    // (e.g. permissions) must abort instead of being overwritten with generated settings.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw error;
  }
}
