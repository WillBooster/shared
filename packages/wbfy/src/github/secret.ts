import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

import dotenv from 'dotenv';
import type sodiumModule from 'libsodium-wrappers';

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

    const usesFnox = fs.existsSync(path.resolve(config.dirPath, 'fnox.toml'));
    let secretsToUpload: Record<string, string>;
    let obsoleteSecretNames: string[];
    if (usesFnox) {
      // fnox.toml carries the age-encrypted app secrets in the repository itself; CI only needs
      // the age private key to decrypt them. The key is read from the local fnox identity and
      // NEVER written anywhere inside the repository.
      const ageKey = readFnoxAgeSecretKey();
      if (!ageKey) return;
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

function readFnoxAgeSecretKey(): string | undefined {
  const identityPath = path.join(os.homedir(), '.config', 'fnox', 'age.txt');
  let content: string;
  try {
    content = fs.readFileSync(identityPath, 'utf8');
  } catch {
    console.warn(`Skip uploading FNOX_AGE_KEY because ${identityPath} is missing.`);
    return undefined;
  }
  const keyLine = content.split('\n').find((line) => line.trim().startsWith('AGE-SECRET-KEY-'));
  if (!keyLine) {
    console.warn(`Skip uploading FNOX_AGE_KEY because ${identityPath} contains no AGE-SECRET-KEY line.`);
    return undefined;
  }
  return keyLine.trim();
}

function getSodium(): typeof sodiumModule {
  // libsodium-wrappers' ESM entry can bind to libsodium@0.8.3, whose default
  // export no longer exposes ready. The CommonJS entry keeps the API shape.
  return require('libsodium-wrappers') as typeof sodiumModule;
}
