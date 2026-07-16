import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

import dotenv from 'dotenv';
import type sodiumModule from 'libsodium-wrappers';
import { parse } from 'smol-toml';

import { FNOX_AGE_RECIPIENTS } from '../generators/fnoxToml.js';
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
      // Parse the TOML instead of searching the raw text: a recipient mentioned only in a comment
      // must not count. This also catches the case where generateFnoxToml failed earlier.
      const recipients = readFnoxAgeRecipients(fnoxTomlPath);
      const missingRecipients = FNOX_AGE_RECIPIENTS.filter((recipient) => !recipients.has(recipient));
      if (missingRecipients.length > 0) {
        console.error(
          `Skip uploading FNOX_AGE_KEY because [providers.age].recipients in fnox.toml misses the following age public keys (generateFnoxToml should have added them): ${missingRecipients.join(', ')}`
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
        } catch (error) {
          // Most repositories never had the legacy secret, so its absence is the expected outcome.
          if ((error as { status?: number } | undefined)?.status === 404) continue;
          console.error(`Failed to delete the obsolete secret ${secretName}:`, error);
          process.exitCode = 1;
        }
      }
    } catch (error) {
      console.error('Failed to upload secrets due to:', (error as Error | undefined)?.stack ?? error);
      process.exitCode = 1;
    }
  });
}

function readFnoxAgeRecipients(fnoxTomlPath: string): Set<string> {
  try {
    const settings = parse(fs.readFileSync(fnoxTomlPath, 'utf8')) as {
      providers?: Record<string, Record<string, unknown> | undefined>;
    };
    const recipients = settings.providers?.age?.recipients;
    return new Set(Array.isArray(recipients) ? recipients.filter((r): r is string => typeof r === 'string') : []);
  } catch {
    // An unreadable or unparsable fnox.toml yields no recipients, so the caller reports an error.
    return new Set();
  }
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
      `Failed to upload FNOX_AGE_KEY because ${identityPath} is missing. Copy the existing CI age identity from the team credential store to that path (run \`mkdir -p ~/.config/fnox\` first); the personal ~/.config/fnox/age.txt is deliberately not used. Generate a brand-new identity with age-keygen only when rotating the CI key, and register its public key in FNOX_AGE_RECIPIENTS.`
    );
    return undefined;
  }
  // Require the `# public key:` comment (age-keygen always writes it) and verify it against the
  // recipient list: skipping the check when the comment is absent would let a hand-assembled file
  // containing an arbitrary private key be uploaded unverified.
  const publicKeyLine = content.split('\n').find((line) => line.includes('public key:'));
  if (!publicKeyLine || !FNOX_AGE_RECIPIENTS.some((recipient) => publicKeyLine.includes(recipient))) {
    console.error(
      `Failed to upload FNOX_AGE_KEY because the \`# public key:\` comment in ${identityPath} is missing or not listed in FNOX_AGE_RECIPIENTS, so the uploaded key could not be verified to decrypt the committed secrets.`
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
