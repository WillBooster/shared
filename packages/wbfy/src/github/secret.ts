import child_process from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

import dotenv from 'dotenv';
import type sodiumModule from 'libsodium-wrappers';
import { parse } from 'smol-toml';

import { FNOX_AGE_RECIPIENTS, hasFnoxSyncFailed, resolveFnoxCommand } from '../generators/fnoxToml.js';
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
  // Covers the dotenv path too: a failed synchronization may mean an unsupported fnox layout
  // (e.g. nested configs without a root fnox.toml) whose FNOX_AGE_KEY must not be deleted.
  if (hasFnoxSyncFailed()) {
    console.error('Skip uploading secrets because synchronizing the fnox age recipients failed earlier in this run.');
    process.exitCode = 1;
    return;
  }
  const octokit = getOctokit(owner);
  // GitHub repository secrets are repository-wide and CI checks out the remote default branch,
  // so every fnox decision below is made from the REMOTE default-branch contents, not the local
  // working tree: verifying a local (or pushed-feature-branch, or fork) migration would rotate
  // the key before compatible ciphertext reaches the branch CI actually runs against.
  const remoteFnoxContents = await fetchDefaultBranchFnoxConfigs(octokit, owner, repo);
  const localUsesFnox = fs.existsSync(path.resolve(config.dirPath, 'fnox.toml'));
  let secretsToUpload: Record<string, string>;
  let obsoleteSecretNames: string[];
  if (localUsesFnox || remoteFnoxContents.size > 0) {
    // fnox.toml carries the age-encrypted app secrets in the repository itself; CI only needs
    // the age private key to decrypt them. The key is read from the local CI-dedicated fnox
    // identity (never the personal one) and NEVER written anywhere inside the repository.
    const unsupportedPaths = [...remoteFnoxContents.keys()].filter((relPath) => path.basename(relPath) !== 'fnox.toml');
    if (unsupportedPaths.length > 0) {
      console.error(
        `Skip uploading FNOX_AGE_KEY because the default branch of ${owner}/${repo} contains unsupported fnox config files: ${unsupportedPaths.join(', ')}. Merge them into the adjacent fnox.toml.`
      );
      process.exitCode = 1;
      return;
    }
    const rootContent = remoteFnoxContents.get('fnox.toml');
    if (!rootContent) {
      console.error(
        `Skip uploading FNOX_AGE_KEY because the default branch of ${owner}/${repo} has no root fnox.toml. Merge and push the fnox migration to the default branch, then rerun wbfy --env.`
      );
      process.exitCode = 1;
      return;
    }
    // Parse the TOML instead of searching the raw text: a recipient mentioned only in a comment
    // must not count. Check every fnox.toml, not just the root one: a nested config overrides
    // the root via fnox's hierarchical loading.
    for (const [relPath, content] of remoteFnoxContents) {
      // The decryptability verification below runs `fnox reencrypt --provider age`, so a layout
      // it cannot cover (imports, differently named age providers, profile providers) would
      // leave secrets unverified; fail instead of proceeding.
      const layoutIssue = findFnoxLayoutIssue(content);
      if (layoutIssue) {
        console.error(
          `Skip uploading FNOX_AGE_KEY because ${relPath} on the default branch ${layoutIssue}. Fix it (wbfy reports the same issue during synchronization), push, and rerun wbfy --env.`
        );
        process.exitCode = 1;
        return;
      }
      const recipients = readFnoxAgeRecipients(content);
      // A nested config without its own age provider inherits the root one; only the root
      // fnox.toml must declare it.
      if (!recipients) {
        if (relPath === 'fnox.toml') {
          console.error(
            `Skip uploading FNOX_AGE_KEY because fnox.toml on the default branch declares no [providers.age] table.`
          );
          process.exitCode = 1;
          return;
        }
        continue;
      }
      // Require the EXACT recipient set: an extra (e.g. removed developer's) recipient means the
      // ciphertexts remain decryptable by an identity that is no longer authorized.
      const missingRecipients = FNOX_AGE_RECIPIENTS.filter((recipient) => !recipients.has(recipient.publicKey));
      const unexpectedRecipients = [...recipients].filter(
        (publicKey) => !FNOX_AGE_RECIPIENTS.some((recipient) => recipient.publicKey === publicKey)
      );
      if (missingRecipients.length > 0 || unexpectedRecipients.length > 0) {
        console.error(
          `Skip uploading FNOX_AGE_KEY because [providers.age].recipients in ${relPath} on the default branch does not match FNOX_AGE_RECIPIENTS exactly (missing: ${missingRecipients
            .map((recipient) => recipient.publicKey)
            .join(
              ', '
            )}; unexpected: ${unexpectedRecipients.join(', ')}). Merge and push the wbfy migration, then rerun wbfy --env.`
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
    // every age secret of the default branch with ONLY the CI key before replacing the secret.
    if (!verifyCiKeyDecryptsAllSecrets(remoteFnoxContents, ageKey, config.dirPath)) {
      process.exitCode = 1;
      return;
    }
    secretsToUpload = { FNOX_AGE_KEY: ageKey };
    obsoleteSecretNames = [...DEPRECATED_SECRET_NAMES, 'DOT_ENV', 'DOT_ENV_PRODUCTION'];
  } else {
    // dotenv.config would also inject the values into process.env, leaking this repository's
    // secrets to every later subprocess and repository handled in the same wbfy invocation.
    const envPath = path.resolve(config.dirPath, '.env');
    secretsToUpload = fs.existsSync(envPath) ? dotenv.parse(fs.readFileSync(envPath, 'utf8')) : {};
    for (const name of ['GH_BOT_PAT', 'GH_BOT_PAT_FOR_WILLBOOSTER', 'GH_BOT_PAT_FOR_WILLBOOSTERLAB']) {
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      delete secretsToUpload[name];
    }
    // A repository that migrated away from fnox must not keep the shared CI decryption key, even
    // when there are no replacement secrets to upload — so no early return on an empty .env.
    obsoleteSecretNames = [...DEPRECATED_SECRET_NAMES, 'FNOX_AGE_KEY'];
  }

  // Never upload a secret that is about to be deleted: a .env could still contain e.g.
  // FNOX_AGE_KEY or a deprecated name, and a PUT followed by a failed DELETE would leave the
  // obsolete credential freshly installed.
  for (const name of obsoleteSecretNames) {
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
    delete secretsToUpload[name];
  }

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

// Fetches the content of every fnox-like config file on the remote default branch, keyed by its
// repository-relative path.
async function fetchDefaultBranchFnoxConfigs(
  octokit: ReturnType<typeof getOctokit>,
  owner: string,
  repo: string
): Promise<Map<string, string>> {
  const repoResponse = await octokit.request('GET /repos/{owner}/{repo}', { owner, repo });
  const defaultBranch = repoResponse.data.default_branch;
  // Pin everything to one commit: enumerating the tree and fetching contents through the mutable
  // branch name could mix two commits (and miss a just-added config) if the branch advances
  // between requests.
  const commitResponse = await octokit.request('GET /repos/{owner}/{repo}/commits/{ref}', {
    owner,
    repo,
    ref: defaultBranch,
  });
  const commitSha = commitResponse.data.sha;
  const treeResponse = await octokit.request('GET /repos/{owner}/{repo}/git/trees/{tree_sha}', {
    owner,
    repo,
    tree_sha: commitSha,
    recursive: '1',
  });
  // Fail closed: a truncated tree could hide a fnox config whose ciphertext was never verified.
  if (treeResponse.data.truncated) {
    throw new Error(`The git tree of ${owner}/${repo}@${defaultBranch} is too large to enumerate fnox configs.`);
  }
  const contents = new Map<string, string>();
  for (const entry of treeResponse.data.tree) {
    const entryPath = entry.path ?? '';
    if (entry.type !== 'blob' || !/^\.?fnox(\..+)?\.toml$/u.test(path.basename(entryPath))) continue;
    const fileResponse = await octokit.request('GET /repos/{owner}/{repo}/contents/{path}', {
      owner,
      repo,
      path: entryPath,
      ref: commitSha,
      headers: { accept: 'application/vnd.github.raw+json' },
    });
    contents.set(entryPath, fileResponse.data as unknown as string);
  }
  return contents;
}

// Proves the CI key alone can decrypt every age secret of the given (remote default-branch) fnox
// configs by running a REAL `fnox reencrypt` on a temporary mirror of them with ONLY the CI
// identity available (isolated HOME, all FNOX_* variables stripped; fnox.local.toml is local-only
// and never part of the mirror). Unlike `fnox export`, reencrypt fails loudly on an undecryptable
// ciphertext even when the secret declares a plaintext `default` fallback, and it covers secrets
// excluded from exports (e.g. `env = false`). Mutations stay in the mirror.
function verifyCiKeyDecryptsAllSecrets(
  fnoxContents: Map<string, string>,
  ciAgeKey: string,
  repoDirPath: string
): boolean {
  // The mirror must live OUTSIDE any repository (not in <repo>/.tmp): fnox searches parent
  // directories for configs, so a mirror inside the repository would hierarchically merge the
  // repository's real fnox.toml and break the isolation this check depends on.
  const tempDirPath = fs.mkdtempSync(path.join(os.tmpdir(), 'wbfy-ci-age-'));
  const tempRepoDirPath = path.join(tempDirPath, 'repo');
  const emptyHomeDirPath = path.join(tempDirPath, 'home');
  // Resolve a possible mise shim to the real fnox binary BEFORE isolating HOME: the shim refuses
  // to run once mise loses its trust state under the isolated HOME.
  const fnoxCommand = resolveFnoxCommand(repoDirPath);
  try {
    fs.mkdirSync(emptyHomeDirPath, { recursive: true });
    for (const [relPath, content] of fnoxContents) {
      const filePath = path.join(tempRepoDirPath, relPath);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, content);
    }
    const env = {
      ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('FNOX_'))),
      FNOX_AGE_KEY: ciAgeKey,
      HOME: emptyHomeDirPath,
      XDG_CONFIG_HOME: emptyHomeDirPath,
    };
    for (const [relPath, content] of fnoxContents) {
      const tempConfigDirPath = path.join(tempRepoDirPath, path.dirname(relPath));
      const profileNames = Object.keys((parse(content) as { profiles?: Record<string, unknown> }).profiles ?? {});
      const profileArgsList = [[], ...profileNames.map((name) => ['--no-defaults', `--profile=${name}`])];
      for (const profileArgs of profileArgsList) {
        const proc = child_process.spawnSync(
          fnoxCommand,
          ['reencrypt', '--force', '--no-daemon', '--provider', 'age', ...profileArgs],
          { cwd: tempConfigDirPath, encoding: 'utf8', stdio: 'pipe', env }
        );
        if (proc.status !== 0) {
          console.error(
            `Skip uploading FNOX_AGE_KEY because the CI age key cannot decrypt every secret governed by ${relPath} on the default branch. Run \`fnox reencrypt\` with the full recipient list, push, and rerun wbfy --env. fnox reported:\n${(proc.stderr || proc.error?.message || '').trim()}`
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

// Returns a description of a config layout the CI-key verification cannot cover, or undefined
// when the standard single-file, single-age-provider layout is used.
function findFnoxLayoutIssue(fnoxTomlContent: string): string | undefined {
  try {
    const settings = parse(fnoxTomlContent) as {
      import?: unknown;
      providers?: Record<string, Record<string, unknown> | undefined>;
      profiles?: Record<string, Record<string, unknown> | undefined>;
    };
    if (settings.import !== undefined) return 'uses the unsupported `import` setting';
    const nonStandardAgeProviderNames = Object.entries(settings.providers ?? {})
      .filter(([name, provider]) => (provider?.type === 'age') !== (name === 'age'))
      .map(([name]) => name);
    if (nonStandardAgeProviderNames.length > 0) {
      return `declares age providers not named \`age\` (or an \`age\` provider of another type): ${nonStandardAgeProviderNames.join(', ')}`;
    }
    const profilesWithProviders = Object.entries(settings.profiles ?? {})
      .filter(([, profile]) => profile?.providers)
      .map(([name]) => name);
    if (profilesWithProviders.length > 0) {
      return `declares unsupported profile-specific providers: ${profilesWithProviders.join(', ')}`;
    }
    return undefined;
  } catch {
    return 'cannot be parsed as TOML';
  }
}

function readFnoxAgeRecipients(fnoxTomlContent: string): Set<string> | undefined {
  try {
    const settings = parse(fnoxTomlContent) as {
      providers?: Record<string, Record<string, unknown> | undefined>;
    };
    if (!settings.providers?.age) return undefined;
    const recipients = settings.providers.age.recipients;
    return new Set(Array.isArray(recipients) ? recipients.filter((r): r is string => typeof r === 'string') : []);
  } catch {
    // An unparsable fnox.toml yields no recipients, so the caller reports an error.
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
