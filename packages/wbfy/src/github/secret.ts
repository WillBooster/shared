import child_process from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

import dotenv from 'dotenv';
import type sodiumModule from 'libsodium-wrappers';
import { parse } from 'smol-toml';

import {
  FNOX_AGE_RECIPIENTS,
  hasFnoxSyncFailed,
  listFnoxTomlDirPaths,
  readFnoxProfileNames,
} from '../generators/fnoxToml.js';
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

    // The user explicitly requested a secret upload (--env), so any failure — including
    // filesystem/validation errors before the GitHub requests — must fail the run instead of
    // being swallowed by functionIgnoringException.
    try {
      await uploadSecrets(config, owner, repo);
    } catch (error) {
      console.error('Failed to upload secrets due to:', (error as Error | undefined)?.stack ?? error);
      process.exitCode = 1;
    }
  });
}

async function uploadSecrets(config: PackageConfig, owner: string, repo: string): Promise<void> {
  const fnoxTomlPath = path.resolve(config.dirPath, 'fnox.toml');
  const usesFnox = fs.existsSync(fnoxTomlPath);
  let secretsToUpload: Record<string, string>;
  let obsoleteSecretNames: string[];
  if (usesFnox) {
    // fnox.toml carries the age-encrypted app secrets in the repository itself; CI only needs
    // the age private key to decrypt them. The key is read from the local CI-dedicated fnox
    // identity (never the personal one) and NEVER written anywhere inside the repository.
    if (hasFnoxSyncFailed()) {
      console.error(
        'Skip uploading FNOX_AGE_KEY because synchronizing the fnox age recipients failed earlier in this run.'
      );
      process.exitCode = 1;
      return;
    }
    // Parse the TOML instead of searching the raw text: a recipient mentioned only in a comment
    // must not count. This also catches the case where generateFnoxToml failed earlier. Check
    // every fnox.toml in the repository, not just the root one: a workspace package's config
    // overrides the root via fnox's hierarchical loading.
    const managedDirPaths = listFnoxTomlDirPaths(config.dirPath);
    if (!managedDirPaths.includes(path.resolve(config.dirPath))) {
      // A gitignored fnox.toml never reaches CI checkouts, so CI has no use for the shared key
      // — and the decryptability checks below would silently verify nothing.
      console.error(
        `Skip uploading FNOX_AGE_KEY because ${fnoxTomlPath} is invisible to git (gitignored?). Commit it or remove it.`
      );
      process.exitCode = 1;
      return;
    }
    for (const dirPath of managedDirPaths) {
      const tomlPath = path.resolve(dirPath, 'fnox.toml');
      const recipients = readFnoxAgeRecipients(tomlPath);
      // A nested config without its own age provider inherits the root one; only the root
      // fnox.toml must declare it.
      if (!recipients) {
        if (tomlPath === fnoxTomlPath) {
          console.error(`Skip uploading FNOX_AGE_KEY because ${tomlPath} declares no [providers.age] table.`);
          process.exitCode = 1;
          return;
        }
        continue;
      }
      const missingRecipients = FNOX_AGE_RECIPIENTS.filter((recipient) => !recipients.has(recipient.publicKey));
      if (missingRecipients.length > 0) {
        console.error(
          `Skip uploading FNOX_AGE_KEY because [providers.age].recipients in ${tomlPath} misses the following age public keys (generateFnoxToml should have added them): ${missingRecipients
            .map((recipient) => recipient.publicKey)
            .join(', ')}`
        );
        process.exitCode = 1;
        return;
      }
    }
    const ageKey = readCiAgeSecretKey();
    if (!ageKey) {
      process.exitCode = 1;
      return;
    }
    // Matching recipients do not prove the committed ciphertexts were actually re-encrypted for
    // the CI key (e.g. someone hand-added the recipient without `fnox reencrypt`), so decrypt
    // every age secret with ONLY the CI key before replacing the repository secret.
    if (!verifyCiKeyDecryptsAllSecrets(config.dirPath, ageKey)) {
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
    // A repository that migrated away from fnox must not keep the shared CI decryption key, even
    // when there are no replacement secrets to upload — so no early return on an empty .env.
    obsoleteSecretNames = [...DEPRECATED_SECRET_NAMES, 'FNOX_AGE_KEY'];
  }

  const octokit = getOctokit(owner);

  if (Object.keys(secretsToUpload).length > 0) {
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
}

// Proves the CI key alone can decrypt every committed age secret by running a REAL
// `fnox reencrypt` on a temporary copy of the repository's fnox.toml files with ONLY the CI
// identity available (isolated HOME, all FNOX_* variables stripped, fnox.local.toml not copied so
// local overrides cannot shadow committed secrets). Unlike `fnox export`, reencrypt fails loudly
// on an undecryptable ciphertext even when the secret declares a plaintext `default` fallback,
// and it covers secrets excluded from exports (e.g. `env = false`). Mutations stay in the copy.
function verifyCiKeyDecryptsAllSecrets(rootDirPath: string, ciAgeKey: string): boolean {
  // The copy must live OUTSIDE the repository (not in <repo>/.tmp): fnox searches parent
  // directories for configs, so a copy inside the repository would hierarchically merge the
  // repository's real fnox.toml and break the isolation this check depends on.
  const tempDirPath = fs.mkdtempSync(path.join(os.tmpdir(), 'wbfy-ci-age-'));
  const tempRepoDirPath = path.join(tempDirPath, 'repo');
  const emptyHomeDirPath = path.join(tempDirPath, 'home');
  try {
    fs.mkdirSync(emptyHomeDirPath, { recursive: true });
    const dirPaths = listFnoxTomlDirPaths(rootDirPath);
    for (const dirPath of dirPaths) {
      const tempConfigDirPath = path.join(tempRepoDirPath, path.relative(rootDirPath, dirPath));
      fs.mkdirSync(tempConfigDirPath, { recursive: true });
      fs.copyFileSync(path.resolve(dirPath, 'fnox.toml'), path.join(tempConfigDirPath, 'fnox.toml'));
    }
    const env = {
      ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('FNOX_'))),
      FNOX_AGE_KEY: ciAgeKey,
      HOME: emptyHomeDirPath,
      XDG_CONFIG_HOME: emptyHomeDirPath,
    };
    for (const dirPath of dirPaths) {
      const tempConfigDirPath = path.join(tempRepoDirPath, path.relative(rootDirPath, dirPath));
      const profileArgsList = [[], ...readFnoxProfileNames(dirPath).map((name) => ['--no-defaults', '-P', name])];
      for (const profileArgs of profileArgsList) {
        const proc = child_process.spawnSync(
          'fnox',
          ['reencrypt', '--force', '--no-daemon', '--provider', 'age', ...profileArgs],
          { cwd: tempConfigDirPath, encoding: 'utf8', stdio: 'pipe', env }
        );
        if (proc.status !== 0) {
          console.error(
            `Skip uploading FNOX_AGE_KEY because the CI age key cannot decrypt every secret governed by ${path.resolve(
              dirPath,
              'fnox.toml'
            )}. Run \`fnox reencrypt\` with the full recipient list and rerun wbfy. fnox reported:\n${(proc.stderr || proc.error?.message || '').trim()}`
          );
          return false;
        }
      }
    }
    return true;
  } finally {
    fs.rmSync(tempDirPath, { recursive: true, force: true });
  }
}

function readFnoxAgeRecipients(fnoxTomlPath: string): Set<string> | undefined {
  try {
    const settings = parse(fs.readFileSync(fnoxTomlPath, 'utf8')) as {
      providers?: Record<string, Record<string, unknown> | undefined>;
    };
    if (!settings.providers?.age) return undefined;
    const recipients = settings.providers.age.recipients;
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
  // CI entry exactly: skipping the check when the comment is absent would let a hand-assembled
  // file containing an arbitrary private key be uploaded unverified, and matching any recipient
  // would let a personal identity copied to this path leak to every repository's CI.
  const ciPublicKey = FNOX_AGE_RECIPIENTS.find((recipient) => recipient.name === 'ci')?.publicKey ?? '';
  // Compare the whole trimmed comment value, not a substring match: a personal identity whose
  // comment merely mentions the CI key must not pass.
  const publicKeyLine = content.split('\n').find((line) => line.includes('public key:'));
  const commentedPublicKey = publicKeyLine?.split('public key:')[1]?.trim();
  if (!ciPublicKey || commentedPublicKey !== ciPublicKey) {
    console.error(
      `Failed to upload FNOX_AGE_KEY because the \`# public key:\` comment in ${identityPath} is missing or differs from the CI age public key (${ciPublicKey}), so the file does not hold the CI-dedicated identity.`
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
