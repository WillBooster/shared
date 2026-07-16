import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

import dotenv from 'dotenv';
import type sodiumModule from 'libsodium-wrappers';

import { CI_AGE_PUBLIC_KEY } from '../generators/fnoxToml.js';
import { logger } from '../logger.js';
import { options } from '../options.js';
import type { PackageConfig } from '../packageConfig.js';
import { getOctokit, gitHubUtil, hasGitHubToken } from '../utils/githubUtil.js';

const DEPRECATED_SECRET_NAMES = ['READY_DISCORD_WEBHOOK_URL', 'GH_BOT_PAT', 'PUBLIC_GH_BOT_PAT'];
const require = createRequire(import.meta.url);

export async function setupSecrets(config: PackageConfig): Promise<void> {
  return logger.functionIgnoringException('setupSecrets', async () => {
    const [owner, repo] = gitHubUtil.getOrgAndName(config.repository ?? '');
    if (!owner || !repo || owner !== 'WillBoosterLab') return;
    if (!hasGitHubToken(owner) || !options.doesUploadEnvVars) return;

    const fnoxTomlPath = path.resolve(config.dirPath, 'fnox.toml');
    const usesFnox = fs.existsSync(fnoxTomlPath);
    let secretsToUpload: Record<string, string>;
    let obsoleteSecretNames: string[];
    if (usesFnox) {
      // fnox.toml carries the age-encrypted app secrets in the repository itself; CI only needs
      // the age private key to decrypt them. The key is read from the local CI-dedicated fnox
      // identity (never the personal one) and NEVER written anywhere inside the repository.
      if (!fs.readFileSync(fnoxTomlPath, 'utf8').includes(CI_AGE_PUBLIC_KEY)) {
        console.error(
          `Skip uploading FNOX_AGE_KEY because fnox.toml does not list the CI age public key as a recipient. Add ${CI_AGE_PUBLIC_KEY} to [providers.age].recipients and run \`fnox reencrypt\`.`
        );
        process.exitCode = 1;
        return;
      }
      const ageKey = readCiAgeSecretKey();
      if (!ageKey) {
        process.exitCode = 1;
        return;
      }
      secretsToUpload = { FNOX_AGE_KEY: ageKey };
      obsoleteSecretNames = [...DEPRECATED_SECRET_NAMES, 'DOT_ENV', 'DOT_ENV_PRODUCTION'];
    } else {
      secretsToUpload = dotenv.config({ path: path.resolve(config.dirPath, '.env'), quiet: true }).parsed ?? {};
      for (const name of ['GH_BOT_PAT', 'GH_BOT_PAT_FOR_WILLBOOSTER', 'GH_BOT_PAT_FOR_WILLBOOSTERLAB']) {
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
        delete secretsToUpload[name];
      }
      if (Object.keys(secretsToUpload).length === 0) return;
      obsoleteSecretNames = DEPRECATED_SECRET_NAMES;
    }

    const octokit = getOctokit(owner);

    try {
      // Requires Secrets permission
      const response = await octokit.request('GET /repos/{owner}/{repo}/actions/secrets/public-key', {
        owner,
        repo,
      });
      const { key, key_id: keyId } = response.data;

      const sodium = getSodium();
      await sodium.ready;

      for (const [name, secret] of Object.entries(secretsToUpload)) {
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

      // Delete legacy secrets only after every replacement was uploaded successfully; deleting first
      // would leave the repository without any working credential if an upload step failed.
      for (const secretName of obsoleteSecretNames) {
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
    } catch (error) {
      console.warn('Skip setupSecrets due to:', (error as Error | undefined)?.stack ?? error);
    }
  });
}

function readCiAgeSecretKey(): string | undefined {
  // The CI-dedicated identity is separate from the personal one (~/.config/fnox/age.txt) so that
  // the personal key never leaves the local machine and the CI key can be rotated independently.
  const identityPath = path.join(os.homedir(), '.config', 'fnox', 'ci-age.txt');
  let content: string;
  try {
    content = fs.readFileSync(identityPath, 'utf8');
  } catch {
    console.error(
      `Failed to upload FNOX_AGE_KEY because ${identityPath} is missing. Create the CI-dedicated identity with \`age-keygen -o ${identityPath}\`; the personal ~/.config/fnox/age.txt is deliberately not used.`
    );
    return undefined;
  }
  const publicKeyLine = content.split('\n').find((line) => line.includes('public key:'));
  if (publicKeyLine && !publicKeyLine.includes(CI_AGE_PUBLIC_KEY)) {
    console.error(
      `Failed to upload FNOX_AGE_KEY because the public key in ${identityPath} does not match the expected CI age public key (${CI_AGE_PUBLIC_KEY}).`
    );
    return undefined;
  }
  const keyLine = content.split('\n').find((line) => line.trim().startsWith('AGE-SECRET-KEY-'));
  if (!keyLine) {
    console.error(`Failed to upload FNOX_AGE_KEY because ${identityPath} contains no AGE-SECRET-KEY line.`);
    return undefined;
  }
  return keyLine.trim();
}

function getSodium(): typeof sodiumModule {
  // libsodium-wrappers' ESM entry can bind to libsodium@0.8.3, whose default
  // export no longer exposes ready. The CommonJS entry keeps the API shape.
  return require('libsodium-wrappers') as typeof sodiumModule;
}
