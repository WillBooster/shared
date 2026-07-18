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
  findFnoxLayoutIssue,
  hasFnoxSyncFailed,
  readFnoxAgeRecipients,
  resolveFnoxCommand,
} from '../generators/fnoxToml.js';
import { logger } from '../logger.js';
import { options } from '../options.js';
import type { PackageConfig } from '../packageConfig.js';
import { getOctokit, gitHubUtil, hasGitHubToken } from '../utils/githubUtil.js';

const DEPRECATED_SECRET_NAMES = ['READY_DISCORD_WEBHOOK_URL', 'GH_BOT_PAT', 'PUBLIC_GH_BOT_PAT'];
// The Verdaccio auth token the reusable workflows need as the VERDACCIO_TOKEN secret, age-encrypted
// for the CI recipient of FNOX_AGE_RECIPIENTS only: this repository is public, so the plaintext must
// never be committed, and the CI identity is the only one wbfy --env already requires locally.
// To rotate the TOKEN: in an empty directory whose fnox.toml declares only the CI recipient, run
// `printf '%s' "$TOKEN" | fnox set VERDACCIO_TOKEN` and copy the generated `value` here.
// CAUTION: rotating the CI IDENTITY must re-encrypt this value for the new public key in the SAME
// change as the FNOX_AGE_RECIPIENTS update — decryptVerdaccioToken gates every upload, so a wbfy
// whose recipient list and ciphertext disagree cannot upload anything (including the new key).
const ENCRYPTED_VERDACCIO_TOKEN =
  'YWdlLWVuY3J5cHRpb24ub3JnL3YxCi0+IFgyNTUxOSBud2p2dXFLV2N1NEFaR1MvSnBMVG9WcTY3V3RNd0wwZG9NRStiMXRDV2pRCnlEQ21BRDF6QWhzandFQWhJZlZGTWdKZGhJcDNEK1E3czJPUkpUblg1YVEKLT4gbHgpWy1ncmVhc2UgQFxVb1EgNWJEYDl5ayA+bAphc1hoTHAydmc4akFxMnNBWWp1YWhlV0I1aytMOFB6YUloZ0tuaFdqNGcKLS0tIGZVOW1zQ2xveDREOC95RkFnTEFPdmFXc0FkV212bUNnV2Y3cWcxb3hWRFkKR8rA6Rshr0v84bWEG2Mnr9H04HcBZylYGEp7U19Dp1sqwQ1yKls8Rz5QtzY5SjYY/kEfMfp4JMgBexxFTnbI7nl79u5FSOrPce+xrYZFMnZhv06zB8shZgiidqkTdcwU+rGB2ei72VTItox9CqmvpGgeonuTuhOP5+9wOPb2E6IC8FpeZLGHczSYxmuIOPMdt80IrjBfqECcv0u6cWDAOHuzwx4j9tyxl49YgU56lA9XOMA2+mSfeq/dBkTFf9Hap8eLcXzGE25TT/xMWkf6cDIn+z8JpzNuyBQUKggggtztooJ7k7ulkr1JaSyFlVCPIrPNBdo/FDbSy9aG';
const require = createRequire(import.meta.url);

// Secret management is deliberately ASYMMETRIC between the two organizations:
// - WillBooster (paid plan): CLOUDFLARE_API_TOKEN / FNOX_AGE_KEY / VERDACCIO_TOKEN are
//   ORGANIZATION secrets registered manually by an org admin, with per-repository visibility.
//   wbfy must never create, update, or delete them (neither at the org level nor as
//   repository-level copies) — it only verifies availability and reports what the admin must do.
// - WillBoosterLab (free plan): GitHub Free cannot share organization secrets with private
//   repositories, so wbfy --env keeps provisioning FNOX_AGE_KEY / VERDACCIO_TOKEN as repository
//   secrets automatically.
const ORG_MANAGED_SECRET_NAMES = ['CLOUDFLARE_API_TOKEN', 'FNOX_AGE_KEY', 'VERDACCIO_TOKEN'];

export async function setupSecrets(config: PackageConfig): Promise<void> {
  return logger.functionIgnoringException('setupSecrets', async () => {
    const [owner, repo] = gitHubUtil.getOrgAndName(config.repository ?? '');
    if (!owner || !repo || (owner !== 'WillBooster' && owner !== 'WillBoosterLab')) return;
    if (!hasGitHubToken(owner) || !options.doesUploadEnvVars) return;

    // The user explicitly requested secret handling (--env), so any failure — including
    // filesystem/validation errors before the GitHub requests — must fail the run instead of
    // being swallowed by functionIgnoringException.
    try {
      await (owner === 'WillBooster'
        ? verifyOrgManagedSecrets(config, owner, repo)
        : uploadSecrets(config, owner, repo));
    } catch (error) {
      console.error('Failed to handle secrets due to:', (error as Error | undefined)?.stack ?? error);
      process.exitCode = 1;
    }
  });
}

// Verifies that every org-managed secret this WillBooster-org repository needs is visible to it
// as an ORGANIZATION secret, without mutating anything: registration and repository visibility
// are manual org-admin operations by policy.
async function verifyOrgManagedSecrets(config: PackageConfig, owner: string, repo: string): Promise<void> {
  const octokit = getOctokit(owner);
  const requiredNames = ['VERDACCIO_TOKEN'];
  // Only a ROOT fnox.toml makes CI need FNOX_AGE_KEY (nested fixtures without an age provider
  // neither need nor own the key, and workflow generation keys FNOX_AGE_KEY injection on the root
  // file too), so probe that single path instead of enumerating the whole tree — the recursive
  // scanner uploadSecrets needs for ciphertext verification fails on trees GitHub truncates.
  if (await defaultBranchHasRootFnoxToml(octokit, owner, repo)) requiredNames.push('FNOX_AGE_KEY');
  // Deliberately based on the LOCAL working tree, unlike the remote-based fnox probe: a wrangler
  // config added on a feature branch will need CLOUDFLARE_API_TOKEN as soon as it merges, and
  // surfacing the missing org secret before the deploy workflow lands is the point of this check.
  if (containsWranglerConfig(config.dirPath)) requiredNames.push('CLOUDFLARE_API_TOKEN');

  // GitHub allows far more than one page of secrets, so paginate instead of trusting page one
  // (this Octokit instance carries no paginate plugin, hence the manual loops).
  const orgVisibleNames = new Set<string>();
  for (let page = 1; ; page++) {
    const response = await octokit.request('GET /repos/{owner}/{repo}/actions/organization-secrets', {
      owner,
      repo,
      per_page: 100,
      page,
    });
    for (const secret of response.data.secrets) orgVisibleNames.add(secret.name);
    if (response.data.secrets.length < 100) break;
  }
  const repoLevelNames = new Set<string>();
  for (let page = 1; ; page++) {
    const response = await octokit.request('GET /repos/{owner}/{repo}/actions/secrets', {
      owner,
      repo,
      per_page: 100,
      page,
    });
    for (const secret of response.data.secrets) repoLevelNames.add(secret.name);
    if (response.data.secrets.length < 100) break;
  }

  // process.exitCode is process-global and may already be 1 from an earlier repository in the
  // same wbfy invocation, so gate this repository's success message on a local flag.
  let verified = true;
  for (const name of requiredNames) {
    if (!orgVisibleNames.has(name)) {
      console.error(
        `The organization secret ${name} is not visible to ${owner}/${repo}. Ask a WillBooster org admin to register it as an organization secret (or extend its repository access to this repository) — do NOT create a repository-level copy.${repoLevelNames.has(name) ? ` A repository-level ${name} currently keeps CI working, but it violates the org-secret policy and must be deleted once the organization secret is visible.` : ''}`
      );
      verified = false;
    }
  }
  // A repository secret silently overrides a same-named organization secret, so a stale
  // repository-level copy would keep winning even after the admin rotates the org value.
  for (const name of ORG_MANAGED_SECRET_NAMES) {
    if (orgVisibleNames.has(name) && repoLevelNames.has(name)) {
      console.error(
        `The repository-level secret ${name} in ${owner}/${repo} shadows the organization secret of the same name. After confirming the organization value is current, delete the repository-level copy manually (e.g. \`gh secret delete ${name} --repo ${owner}/${repo}\`); wbfy deliberately never deletes it.`
      );
      verified = false;
    }
  }
  if (verified) {
    console.info(
      `Confirmed the organization secrets required by ${owner}/${repo} are visible: ${requiredNames.join(', ')}.`
    );
  } else {
    process.exitCode = 1;
  }
}

// A single-path existence probe of the remote default branch; verification needs only this
// boolean, not the full fnox contents uploadSecrets enumerates.
async function defaultBranchHasRootFnoxToml(
  octokit: ReturnType<typeof getOctokit>,
  owner: string,
  repo: string
): Promise<boolean> {
  try {
    await octokit.request('GET /repos/{owner}/{repo}/contents/{path}', { owner, repo, path: 'fnox.toml' });
    return true;
  } catch (error) {
    if ((error as { status?: number } | undefined)?.status === 404) return false;
    throw error;
  }
}

// Detects a Cloudflare Workers deployment (root or a directly nested workspace) to decide whether
// CLOUDFLARE_API_TOKEN is required; deeper layouts are out of wbfy's supported structure.
function containsWranglerConfig(rootDirPath: string): boolean {
  const candidateDirPaths = [rootDirPath];
  for (const groupDirName of ['packages', 'apps']) {
    const groupDirPath = path.join(rootDirPath, groupDirName);
    try {
      for (const entry of fs.readdirSync(groupDirPath, { withFileTypes: true })) {
        if (entry.isDirectory()) candidateDirPaths.push(path.join(groupDirPath, entry.name));
      }
    } catch (error) {
      // Only a missing workspace group is benign; an unreadable one (e.g. EACCES) could hide a
      // Worker and must fail the run loudly instead of silently passing verification.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return candidateDirPaths.some((dirPath) =>
    ['wrangler.jsonc', 'wrangler.json', 'wrangler.toml'].some((fileName) => fs.existsSync(path.join(dirPath, fileName)))
  );
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
  const {
    commitSha: verifiedCommitSha,
    contents: remoteFnoxContents,
    defaultBranch,
  } = await fetchDefaultBranchFnoxConfigs(octokit, owner, repo);
  // Verdaccio auth is orthogonal to the fnox migration state (the reusable workflows generate the
  // workspace .npmrc from the VERDACCIO_TOKEN secret either way), so decrypt the token with the CI
  // identity up front and upload it on both branches below.
  const ciAgeKey = readCiAgeSecretKey();
  if (!ciAgeKey) {
    process.exitCode = 1;
    return;
  }
  const verdaccioToken = decryptVerdaccioToken(ciAgeKey, config.dirPath);
  if (!verdaccioToken) {
    process.exitCode = 1;
    return;
  }
  let secretsToUpload: Record<string, string>;
  let obsoleteSecretNames: string[];
  // Choose fnox vs dotenv SOLELY from the remote default branch: an unmerged local migration
  // branch must neither block dotenv secret synchronization nor trigger a premature key upload.
  if (remoteFnoxContents.size > 0) {
    // fnox.toml carries the age-encrypted app secrets in the repository itself; CI only needs
    // the age private key to decrypt them. The key is read from the local CI-dedicated fnox
    // identity (never the personal one) and NEVER written anywhere inside the repository.
    const unsupportedPaths = [...remoteFnoxContents.keys()].filter((relPath) => path.basename(relPath) !== 'fnox.toml');
    if (unsupportedPaths.length > 0) {
      console.error(
        `Skip uploading secrets because the default branch of ${owner}/${repo} contains unsupported fnox config files: ${unsupportedPaths.join(', ')}. Merge them into the adjacent fnox.toml.`
      );
      process.exitCode = 1;
      return;
    }
    const rootContent = remoteFnoxContents.get('fnox.toml');
    if (!rootContent) {
      console.error(
        `Skip uploading secrets because the default branch of ${owner}/${repo} has no root fnox.toml. Merge and push the fnox migration to the default branch, then rerun wbfy --env.`
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
          `Skip uploading secrets because ${relPath} on the default branch ${layoutIssue}. Fix it (wbfy reports the same issue during synchronization), push, and rerun wbfy --env.`
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
            `Skip uploading secrets because fnox.toml on the default branch declares no [providers.age] table.`
          );
          process.exitCode = 1;
          return;
        }
        continue;
      }
      // Require the EXACT recipient set: an extra (e.g. removed developer's) recipient means the
      // ciphertexts remain decryptable by an identity that is no longer authorized. Note that no
      // recipient-set check can prove a REMOVED identity lost access: age ciphertext already
      // readable by it (including every version in git history) stays readable forever, so
      // removing a recipient additionally requires rotating the secret VALUES themselves — an
      // operational task outside wbfy's scope.
      const missingRecipients = FNOX_AGE_RECIPIENTS.filter((recipient) => !recipients.has(recipient.publicKey));
      const unexpectedRecipients = [...recipients].filter(
        (publicKey) => !FNOX_AGE_RECIPIENTS.some((recipient) => recipient.publicKey === publicKey)
      );
      if (missingRecipients.length > 0 || unexpectedRecipients.length > 0) {
        console.error(
          `Skip uploading secrets because [providers.age].recipients in ${relPath} on the default branch does not match FNOX_AGE_RECIPIENTS exactly (missing: ${missingRecipients
            .map((recipient) => recipient.publicKey)
            .join(
              ', '
            )}; unexpected: ${unexpectedRecipients.join(', ')}). Merge and push the wbfy migration, then rerun wbfy --env.`
        );
        process.exitCode = 1;
        return;
      }
    }
    // Matching recipients do not prove the committed ciphertexts were actually re-encrypted for
    // the CI key (e.g. someone hand-added the recipient without `fnox reencrypt`), so decrypt
    // every age secret of the default branch with ONLY the CI key before replacing the secret.
    if (!verifyCiKeyDecryptsAllSecrets(remoteFnoxContents, ciAgeKey, config.dirPath)) {
      process.exitCode = 1;
      return;
    }
    secretsToUpload = { FNOX_AGE_KEY: ciAgeKey, VERDACCIO_TOKEN: verdaccioToken };
    obsoleteSecretNames = [...DEPRECATED_SECRET_NAMES, 'DOT_ENV', 'DOT_ENV_PRODUCTION'];
  } else {
    // dotenv.config would also inject the values into process.env, leaking this repository's
    // secrets to every later subprocess and repository handled in the same wbfy invocation.
    const envPath = path.resolve(config.dirPath, '.env');
    secretsToUpload = fs.existsSync(envPath) ? dotenv.parse(fs.readFileSync(envPath, 'utf8')) : {};
    // The decrypted token is the canonical value; a stale copy in .env must not win.
    secretsToUpload['VERDACCIO_TOKEN'] = verdaccioToken;
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

  // The validation above is only meaningful for the commit it inspected; if the default branch
  // advanced meanwhile (e.g. gained new fnox secrets or dropped fnox entirely), mutating the
  // repository-wide secrets from the stale view could break CI on the new head. Recheck right
  // before mutating; the residual race during the mutation itself is accepted.
  const headResponse = await octokit.request('GET /repos/{owner}/{repo}/commits/{ref}', {
    owner,
    repo,
    ref: defaultBranch,
  });
  if (headResponse.data.sha !== verifiedCommitSha) {
    console.error(
      `Skip updating secrets because the default branch of ${owner}/${repo} advanced during verification (${verifiedCommitSha} -> ${headResponse.data.sha}). Rerun wbfy --env.`
    );
    process.exitCode = 1;
    return;
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

// Fetches the content of every fnox-like config file on the remote default branch (keyed by its
// repository-relative path) together with the inspected commit SHA.
async function fetchDefaultBranchFnoxConfigs(
  octokit: ReturnType<typeof getOctokit>,
  owner: string,
  repo: string
): Promise<{ commitSha: string; contents: Map<string, string>; defaultBranch: string }> {
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
  return { commitSha, contents, defaultBranch };
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
      `Failed to upload secrets because ${identityPath} is missing. Copy the existing CI age identity from the team credential store to that path (run \`mkdir -p ~/.config/fnox\` first); the personal ~/.config/fnox/age.txt is deliberately not used. Generate a brand-new identity with age-keygen only when rotating the CI key, register its public key in FNOX_AGE_RECIPIENTS, and re-encrypt ENCRYPTED_VERDACCIO_TOKEN for it in the same change.`
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
  const lines = content.split('\n');
  const publicKeyLine = lines.find((line) => line.includes('public key:'));
  const commentedPublicKey = publicKeyLine?.split('public key:')[1]?.trim();
  if (!ciPublicKey || commentedPublicKey !== ciPublicKey) {
    console.error(
      `Failed to upload secrets because the \`# public key:\` comment in ${identityPath} is missing or differs from the CI age public key (${ciPublicKey}), so the file does not hold the CI-dedicated identity.`
    );
    return undefined;
  }
  const keyLine = lines.find((line) => line.trim().startsWith('AGE-SECRET-KEY-'));
  if (!keyLine) {
    console.error(`Failed to upload secrets because ${identityPath} contains no AGE-SECRET-KEY line.`);
    return undefined;
  }
  return keyLine.trim();
}

// Decrypts ENCRYPTED_VERDACCIO_TOKEN with the CI age identity by running `fnox get` on a minimal
// fnox.toml in a temporary directory, under the same isolation as verifyCiKeyDecryptsAllSecrets
// (outside any repository so fnox's parent search finds nothing else; isolated HOME with all
// FNOX_* variables stripped, so ONLY the CI key can contribute to decryption).
function decryptVerdaccioToken(ciAgeKey: string, repoDirPath: string): string | undefined {
  const tempDirPath = fs.mkdtempSync(path.join(os.tmpdir(), 'wbfy-verdaccio-'));
  const emptyHomeDirPath = path.join(tempDirPath, 'home');
  const fnoxCommand = resolveFnoxCommand(repoDirPath);
  try {
    fs.mkdirSync(emptyHomeDirPath, { recursive: true });
    const ciPublicKey = FNOX_AGE_RECIPIENTS.find((recipient) => recipient.name === 'ci')?.publicKey ?? '';
    fs.writeFileSync(
      path.join(tempDirPath, 'fnox.toml'),
      `[providers.age]
type = "age"
recipients = ["${ciPublicKey}"]

[secrets]
VERDACCIO_TOKEN = { provider = "age", value = "${ENCRYPTED_VERDACCIO_TOKEN}" }
`
    );
    const env = {
      ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('FNOX_'))),
      FNOX_AGE_KEY: ciAgeKey,
      HOME: emptyHomeDirPath,
      XDG_CONFIG_HOME: emptyHomeDirPath,
    };
    const proc = child_process.spawnSync(fnoxCommand, ['get', '--no-daemon', 'VERDACCIO_TOKEN'], {
      cwd: tempDirPath,
      encoding: 'utf8',
      stdio: 'pipe',
      env,
    });
    // A non-migrated repository pins no fnox through mise, so resolveFnoxCommand may fall back to
    // a bare `fnox` that is absent from PATH; a failed spawn (status null) must not be reported as
    // a decryption failure — the advised re-encryption would not fix it.
    if (proc.error || proc.status === null) {
      console.error(
        `Failed to upload secrets because the fnox command (${fnoxCommand}) could not be executed. Install fnox globally (e.g. \`mise use -g fnox\`) and rerun wbfy --env. Reported: ${(proc.error?.message ?? proc.stderr ?? '').trim()}`
      );
      return undefined;
    }
    // `fnox get` appends a newline; the token itself never contains one.
    const token = proc.status === 0 ? proc.stdout.replace(/\n+$/u, '') : '';
    if (!token) {
      console.error(
        `Failed to upload secrets because the CI age key cannot decrypt the embedded VERDACCIO_TOKEN. Re-encrypt it for the CI recipient (see the comment on ENCRYPTED_VERDACCIO_TOKEN) and release wbfy. fnox reported:\n${(proc.stderr || '').trim()}`
      );
      return undefined;
    }
    return token;
  } finally {
    fs.rmSync(tempDirPath, { recursive: true, force: true });
  }
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
      const settings = parse(content) as { profiles?: Record<string, unknown> };
      const profileNames = Object.keys(settings.profiles ?? {});
      const profileArgsList = [[], ...profileNames.map((name) => ['--no-defaults', `--profile=${name}`])];
      for (const profileArgs of profileArgsList) {
        const proc = child_process.spawnSync(
          fnoxCommand,
          ['reencrypt', '--force', '--no-daemon', '--provider', 'age', ...profileArgs],
          { cwd: tempConfigDirPath, encoding: 'utf8', stdio: 'pipe', env }
        );
        if (proc.status !== 0) {
          console.error(
            `Skip uploading secrets because the CI age key cannot decrypt every secret governed by ${relPath} on the default branch. Run \`fnox reencrypt\` with the full recipient list, push, and rerun wbfy --env. fnox reported:\n${(proc.stderr || proc.error?.message || '').trim()}`
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

function getSodium(): typeof sodiumModule {
  // libsodium-wrappers' ESM entry can bind to libsodium@0.8.3, whose default
  // export no longer exposes ready. The CommonJS entry keeps the API shape.
  return require('libsodium-wrappers') as typeof sodiumModule;
}
