import dotenv from 'dotenv';
import sodium from 'libsodium-wrappers';

import { logger } from '../logger.js';
import { options } from '../options.js';
import type { PackageConfig } from '../packageConfig.js';
import { getOctokit, gitHubUtil, hasGitHubToken } from '../utils/githubUtil.js';

const DEPRECATED_SECRET_NAMES = ['READY_DISCORD_WEBHOOK_URL', 'GH_BOT_PAT', 'PUBLIC_GH_BOT_PAT'];

export async function setupSecrets(config: PackageConfig): Promise<void> {
  return logger.functionIgnoringException('setupSecrets', async () => {
    const [owner, repo] = gitHubUtil.getOrgAndName(config.repository ?? '');
    if (!owner || !repo || owner !== 'WillBoosterLab') return;
    if (!hasGitHubToken(owner) || !options.doesUploadEnvVars) return;

    const parsed = dotenv.config().parsed ?? {};
    if (Object.keys(parsed).length === 0) return;

    const octokit = getOctokit(owner);

    try {
      for (const secretName of DEPRECATED_SECRET_NAMES) {
        try {
          // Requires Secrets permission
          await octokit.request('DELETE /repos/{owner}/{repo}/actions/secrets/{secret_name}', {
            owner,
            repo,
            secret_name: secretName,
          });
        } catch {
          // do nothing
        }
      }

      // Requires Secrets permission
      const response = await octokit.request('GET /repos/{owner}/{repo}/actions/secrets/public-key', {
        owner,
        repo,
      });
      const { key, key_id: keyId } = response.data;

      await sodium.ready;

      for (const [name, secret] of Object.entries(parsed)) {
        if (
          name === 'GH_BOT_PAT' ||
          name === 'GH_BOT_PAT_FOR_WILLBOOSTER' ||
          name === 'GH_BOT_PAT_FOR_WILLBOOSTERLAB'
        ) {
          continue;
        }

        // Convert Secret & Base64 key to Uint8Array.
        const rawKey = sodium.from_base64(key, sodium.base64_variants.ORIGINAL);
        const rawSec = sodium.from_string(secret);

        // Encrypt the secret using LibSodium
        const encBytes = sodium.crypto_box_seal(rawSec, rawKey);

        // Convert encrypted Uint8Array to Base64
        const encBase64 = sodium.to_base64(encBytes, sodium.base64_variants.ORIGINAL);

        // Requires Secrets permission
        await octokit.request('PUT /repos/{owner}/{repo}/actions/secrets/{secret_name}', {
          owner,
          repo,
          secret_name: name,
          encrypted_value: encBase64,
          key_id: keyId,
        });
      }
    } catch (error) {
      console.warn('Skip setupSecrets due to:', (error as Error | undefined)?.stack ?? error);
    }
  });
}
