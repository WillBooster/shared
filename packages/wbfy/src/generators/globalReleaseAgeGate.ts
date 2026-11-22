import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { spawnOrUndefined } from '../utils/spawnUtil.js';
import { getWbfyDirPath } from '../utils/version.js';
import { ungateCargoConfigs } from './cargoConfigToml.js';

/**
 * Applies the organization's minimum-release-age policy to the developer machine's GLOBAL
 * package-manager configs. Repository configs guard only wbfied repositories; a brand-new local
 * project has no bunfig.toml yet, so the global files are the only gate between `bun create` /
 * `npm init` and a freshly compromised release. The same script runs on CI and on the self-hosted
 * runners, so every machine ends up with byte-identical npm, Yarn and Bun settings.
 */
export async function ensureGlobalReleaseAgeGates(): Promise<boolean> {
  const result = await spawnOrUndefined('bash', [path.join(getWbfyDirPath(), 'configs', 'applyReleaseAgeGate.sh')], {
    stdio: 'inherit',
  });
  const scriptSucceeded = result?.status === 0;
  if (!scriptSucceeded)
    console.warn('Failed to apply the minimum-release-age policy to the global package-manager configs.');
  const cargoSucceeded = await ungateGlobalCargoConfig();
  return scriptSucceeded && cargoSucceeded;
}

/**
 * Removes the crate publish-age gate that earlier wbfy versions wrote to the global Cargo config: Cargo has no
 * per-crate exemption, so it also held back our own crates for a week after each release.
 */
async function ungateGlobalCargoConfig(): Promise<boolean> {
  try {
    const cargoHomeDirPath = process.env.CARGO_HOME || path.join(os.homedir(), '.cargo');
    for (const { filePath, content } of await ungateCargoConfigs(cargoHomeDirPath)) {
      await (content ? fs.writeFile(filePath, content) : fs.rm(filePath));
      console.log(`Removed the crate publish-age gate from ${filePath}.`);
    }
    return true;
  } catch (error) {
    console.warn(`Failed to remove the crate publish-age gate from the global Cargo config: ${String(error)}`);
    return false;
  }
}
