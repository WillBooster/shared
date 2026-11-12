import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { spawnOrUndefined } from '../utils/spawnUtil.js';
import { getWbfyDirPath } from '../utils/version.js';
import { gateCargoConfig } from './cargoConfigToml.js';

/**
 * Applies the organization's minimum-release-age policy to the developer machine's GLOBAL
 * package-manager configs. Repository configs guard only wbfied repositories; a brand-new local
 * project has no bunfig.toml or .cargo/config.toml yet, so the global files are the only gate
 * between `bun create` / `npm init` / `cargo new` and a freshly compromised release. The same script
 * runs on CI and on the self-hosted runners, so every machine ends up with byte-identical npm, Yarn
 * and Bun settings; Cargo on those machines runs inside repositories, which carry their own gate.
 */
export async function ensureGlobalReleaseAgeGates(): Promise<boolean> {
  const result = await spawnOrUndefined('bash', [path.join(getWbfyDirPath(), 'configs', 'applyReleaseAgeGate.sh')], {
    stdio: 'inherit',
  });
  const scriptSucceeded = result?.status === 0;
  if (!scriptSucceeded)
    console.warn('Failed to apply the minimum-release-age policy to the global package-manager configs.');
  const cargoSucceeded = await ensureGlobalCargoReleaseAgeGate();
  return scriptSucceeded && cargoSucceeded;
}

async function ensureGlobalCargoReleaseAgeGate(): Promise<boolean> {
  try {
    const cargoHomeDirPath = process.env.CARGO_HOME || path.join(os.homedir(), '.cargo');
    const { filePath, content } = await gateCargoConfig(cargoHomeDirPath);
    if (content === (await fs.readFile(filePath, 'utf8').catch(() => {}))) return true;
    await fs.mkdir(cargoHomeDirPath, { recursive: true });
    // Staged and renamed into place for the same reasons as applyReleaseAgeGate.sh's writes: Cargo
    // must never read a half-written file, and a symlink is replaced instead of written through.
    const stagingFilePath = `${filePath}.${process.pid}.tmp`;
    try {
      await fs.writeFile(stagingFilePath, content, { mode: 0o600 });
      await fs.rename(stagingFilePath, filePath);
    } finally {
      await fs.rm(stagingFilePath, { force: true });
    }
    console.log(`Applied the minimum-release-age policy to ${filePath}.`);
    return true;
  } catch (error) {
    console.warn(`Failed to apply the minimum-release-age policy to the global Cargo config: ${String(error)}`);
    return false;
  }
}
