import path from 'node:path';

import { spawnOrUndefined } from '../utils/spawnUtil.js';
import { getWbfyDirPath } from '../utils/version.js';

/**
 * Applies the organization's minimum-release-age policy to the developer machine's GLOBAL
 * package-manager configs. Repository configs guard only wbfied repositories; a brand-new local
 * project has no bunfig.toml yet, so the global files are the only gate between `bun create` /
 * `npm init` and a freshly compromised release. The same script runs on CI and on the self-hosted
 * runners, so every machine ends up with byte-identical settings.
 */
export async function ensureGlobalReleaseAgeGates(): Promise<boolean> {
  const result = await spawnOrUndefined('bash', [path.join(getWbfyDirPath(), 'configs', 'applyReleaseAgeGate.sh')], {
    stdio: 'inherit',
  });
  if (result?.status === 0) return true;

  console.warn('Failed to apply the minimum-release-age policy to the global package-manager configs.');
  return false;
}
