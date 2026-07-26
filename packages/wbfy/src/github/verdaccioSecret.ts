import childProcess from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import fg from 'fast-glob';

import { FNOX_AGE_RECIPIENTS, resolveFnoxCommand } from '../generators/fnoxToml.js';
import { logger } from '../logger.js';
import type { PackageConfig } from '../packageConfig.js';
import { getGitHubToken, getOctokit, gitHubUtil, hasGitHubToken } from '../utils/githubUtil.js';
import { getWorkspacePackageJsonPaths } from '../utils/workspaceUtil.js';

const SECRET_NAME = 'VERDACCIO_TOKEN';
const PRIVATE_SCOPE = '@willbooster-private/';
const VERDACCIO_HOST = 'verdaccio-production-e389.up.railway.app';

// The Verdaccio auth token the reusable workflows need as the VERDACCIO_TOKEN secret, age-encrypted
// for the CI recipient of FNOX_AGE_RECIPIENTS only: this repository is public, so the plaintext must
// never be committed, and the CI identity is already required on every developer machine that
// provisions secrets. To rotate the TOKEN: in an empty directory whose fnox.toml declares only the
// CI recipient, run `printf '%s' "$TOKEN" | fnox set VERDACCIO_TOKEN` and copy the generated
// `value` here. CAUTION: rotating the CI IDENTITY must re-encrypt this value for the new public key
// in the SAME change as the FNOX_AGE_RECIPIENTS update — decryptEmbeddedVerdaccioToken gates every
// upload, so a wbfy whose recipient list and ciphertext disagree cannot upload anything.
const ENCRYPTED_VERDACCIO_TOKEN =
  'YWdlLWVuY3J5cHRpb24ub3JnL3YxCi0+IFgyNTUxOSBud2p2dXFLV2N1NEFaR1MvSnBMVG9WcTY3V3RNd0wwZG9NRStiMXRDV2pRCnlEQ21BRDF6QWhzandFQWhJZlZGTWdKZGhJcDNEK1E3czJPUkpUblg1YVEKLT4gbHgpWy1ncmVhc2UgQFxVb1EgNWJEYDl5ayA+bAphc1hoTHAydmc4akFxMnNBWWp1YWhlV0I1aytMOFB6YUloZ0tuaFdqNGcKLS0tIGZVOW1zQ2xveDREOC95RkFnTEFPdmFXc0FkV212bUNnV2Y3cWcxb3hWRFkKR8rA6Rshr0v84bWEG2Mnr9H04HcBZylYGEp7U19Dp1sqwQ1yKls8Rz5QtzY5SjYY/kEfMfp4JMgBexxFTnbI7nl79u5FSOrPce+xrYZFMnZhv06zB8shZgiidqkTdcwU+rGB2ei72VTItox9CqmvpGgeonuTuhOP5+9wOPb2E6IC8FpeZLGHczSYxmuIOPMdt80IrjBfqECcv0u6cWDAOHuzwx4j9tyxl49YgU56lA9XOMA2+mSfeq/dBkTFf9Hap8eLcXzGE25TT/xMWkf6cDIn+z8JpzNuyBQUKggggtztooJ7k7ulkr1JaSyFlVCPIrPNBdo/FDbSy9aG';

// Secret management is deliberately ASYMMETRIC between the two organizations:
// - WillBooster (paid plan): VERDACCIO_TOKEN is an ORGANIZATION secret registered manually by an
//   org admin with per-repository visibility. wbfy must never create, update, or delete it
//   (neither at the org level nor as a repository-level copy) — it only verifies availability
//   and reports what the admin must do.
// - WillBoosterLab (free plan): GitHub Free cannot share organization secrets with private
//   repositories, so wbfy provisions VERDACCIO_TOKEN as a repository secret automatically —
//   but ONLY for repositories that actually resolve @willbooster-private/* packages on CI;
//   registering the org-wide credential anywhere else just widens its exposure, so wbfy also
//   DELETES a repository-level copy that is no longer needed.
export async function setupVerdaccioTokenSecret(config: PackageConfig): Promise<void> {
  return logger.functionIgnoringException('setupVerdaccioTokenSecret', async () => {
    const [owner, repo] = gitHubUtil.getOrgAndName(config.repository ?? '');
    if (!owner || !repo || (owner !== 'WillBooster' && owner !== 'WillBoosterLab')) return;
    // Like the other GitHub setup modules, an offline/uncredentialed run skips silently: this
    // function runs on every wbfy invocation, so a missing credential is an expected environment,
    // not a user error like the retired opt-in `wbfy --env` treated it.
    if (!hasGitHubToken(owner)) return;

    const needed = repoResolvesPrivatePackages(config);
    try {
      await (owner === 'WillBooster'
        ? verifyOrgVerdaccioToken(owner, repo, needed)
        : provisionLabVerdaccioToken(config, owner, repo, needed));
    } catch (error) {
      console.error(
        `Failed to manage the ${SECRET_NAME} secret of ${owner}/${repo} due to:`,
        (error as Error | undefined)?.stack ?? error
      );
      process.exitCode = 1;
    }
  });
}

/**
 * Whether CI runs of this repository resolve `@willbooster-private/*` packages (or publish to the
 * private Verdaccio registry) and therefore need the VERDACCIO_TOKEN secret.
 *
 * The scan errs toward FALSE POSITIVES on purpose: a false negative deletes/withholds a credential
 * CI needs (installs break or silently skip `.npmrc` generation), while a false positive merely
 * keeps a secret registered. Hence whole-manifest text scans instead of per-field checks. Sources:
 * every workspace package.json (dependencies of any kind, scripts running `bunx
 * @willbooster-private/...`, a Verdaccio `publishConfig.registry`), root lockfiles, and workflow
 * files. bunfig.toml is deliberately EXCLUDED: `minimumReleaseAgeExcludes` lists the scope in
 * repositories that do not depend on it.
 */
export function repoResolvesPrivatePackages(
  config: Pick<PackageConfig, 'dirPath' | 'doesContainSubPackageJsons' | 'packageJson'>
): boolean {
  const manifestRelPaths = new Set(['package.json', ...getWorkspacePackageJsonPaths(config)]);
  for (const relPath of manifestRelPaths) {
    const content = readFileIfExists(path.resolve(config.dirPath, relPath));
    if (content && (content.includes(PRIVATE_SCOPE) || content.includes(VERDACCIO_HOST))) return true;
  }
  for (const lockfileName of ['bun.lock', 'bun.lockb', 'yarn.lock', 'package-lock.json']) {
    const content = readFileIfExists(path.resolve(config.dirPath, lockfileName));
    if (content?.includes(PRIVATE_SCOPE)) return true;
  }
  // Custom workflows may resolve private packages outside any manifest (e.g. `bunx
  // @willbooster-private/agentic-workflows` in a step). The standard pass-through
  // `VERDACCIO_TOKEN: ${{ secrets.VERDACCIO_TOKEN }}` mentions only the secret name, never the
  // scope, so scanning for the scope does not turn every generated caller into a hit.
  const workflowPaths = fg.sync('.github/workflows/*.{yml,yaml}', { cwd: config.dirPath, absolute: true });
  return workflowPaths.some((workflowPath) => readFileIfExists(workflowPath)?.includes(PRIVATE_SCOPE));
}

function readFileIfExists(filePath: string): string | undefined {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return undefined;
  }
}

// Verifies that a WillBooster-org repository which needs VERDACCIO_TOKEN can see it as an
// ORGANIZATION secret, without mutating anything: registration and repository visibility are
// manual org-admin operations by policy.
async function verifyOrgVerdaccioToken(owner: string, repo: string, needed: boolean): Promise<void> {
  const octokit = getOctokit(owner);
  // GitHub allows far more than one page of secrets, so paginate instead of trusting page one
  // (this Octokit instance carries no paginate plugin, hence the manual loops).
  const assignedOrgNames: string[] = [];
  for (let page = 1; ; page++) {
    const response = await octokit.request('GET /repos/{owner}/{repo}/actions/organization-secrets', {
      owner,
      repo,
      per_page: 100,
      page,
    });
    for (const secret of response.data.secrets) assignedOrgNames.push(secret.name);
    if (response.data.secrets.length < 100) break;
  }
  // A workflow run can use only the first 100 organization secrets sorted alphabetically, so an
  // assigned-but-beyond-limit secret is NOT usable and must not pass verification.
  const usableOrgNames = new Set([...assignedOrgNames].toSorted().slice(0, 100));
  const hasRepoLevelCopy = await repoSecretExists(owner, repo);

  if (needed && !usableOrgNames.has(SECRET_NAME)) {
    console.error(
      assignedOrgNames.includes(SECRET_NAME)
        ? `The organization secret ${SECRET_NAME} is assigned to ${owner}/${repo} but falls beyond the 100-organization-secret limit a workflow run can use (only the alphabetically first 100 are usable). Ask a WillBooster org admin to prune the assigned organization secrets.`
        : `${owner}/${repo} resolves ${PRIVATE_SCOPE}* packages but the organization secret ${SECRET_NAME} is not visible to it. Ask a WillBooster org admin to extend its repository access — do NOT create a repository-level copy.${hasRepoLevelCopy ? ` A repository-level ${SECRET_NAME} currently keeps CI working, but it violates the org-secret policy and must be deleted once the organization secret is visible.` : ''}`
    );
    process.exitCode = 1;
    return;
  }
  // A repository secret silently overrides a same-named organization secret, so a stale
  // repository-level copy would keep winning even after the admin rotates the org value; and in a
  // repository that needs no token at all it is pure unnecessary exposure. Deletion stays manual:
  // wbfy must never mutate org-managed secrets, including repository-level copies of them.
  if (hasRepoLevelCopy) {
    console.error(
      `The repository-level secret ${SECRET_NAME} in ${owner}/${repo} ${
        needed
          ? 'shadows the organization secret of the same name. After confirming the organization value is current, delete the repository-level copy manually'
          : `is unnecessary (no ${PRIVATE_SCOPE}* usage detected) and violates the org-secret policy. Delete it manually`
      } (e.g. \`gh secret delete ${SECRET_NAME} --repo ${owner}/${repo}\`); wbfy deliberately never deletes it.`
    );
    process.exitCode = 1;
  }
}

// Provisions (or removes) the repository-level VERDACCIO_TOKEN of a WillBoosterLab repository.
async function provisionLabVerdaccioToken(
  config: PackageConfig,
  owner: string,
  repo: string,
  needed: boolean
): Promise<void> {
  const octokit = getOctokit(owner);
  const exists = await repoSecretExists(owner, repo);
  if (!needed) {
    if (exists) {
      // Requires Secrets permission
      await octokit.request('DELETE /repos/{owner}/{repo}/actions/secrets/{secret_name}', {
        owner,
        repo,
        secret_name: SECRET_NAME,
      });
      console.info(
        `Deleted the ${SECRET_NAME} repository secret from ${owner}/${repo}: no ${PRIVATE_SCOPE}* usage was detected, and an unregistered secret resolves empty through the caller pass-through (the reusable workflows then skip .npmrc generation harmlessly).`
      );
    }
    return;
  }

  const token = decryptEmbeddedVerdaccioToken(config.dirPath);
  if (!token) {
    if (exists) {
      // The registered secret keeps CI working; only a token refresh is unavailable on this
      // machine, which is the normal state everywhere the CI age identity is absent.
      return;
    }
    console.error(
      `${owner}/${repo} resolves ${PRIVATE_SCOPE}* packages but has no ${SECRET_NAME} repository secret, and this machine cannot decrypt the embedded token (the CI age identity ~/.config/fnox/age-ci-wb.txt is missing or stale). Rerun wbfy on a machine holding the CI identity, or register the secret manually: \`printf '%s' "$TOKEN" | gh secret set ${SECRET_NAME} --repo ${owner}/${repo}\`.`
    );
    process.exitCode = 1;
    return;
  }
  // Upload unconditionally (the PUT is idempotent): secret values cannot be read back, so
  // re-setting on every run is the only way a rotated Verdaccio token propagates across the fleet
  // without manual tracking of which repositories still hold the old value.
  ghSecretSet(owner, repo, token);
  console.info(`${exists ? 'Refreshed' : 'Registered'} the ${SECRET_NAME} repository secret of ${owner}/${repo}.`);
}

async function repoSecretExists(owner: string, repo: string): Promise<boolean> {
  const octokit = getOctokit(owner);
  try {
    await octokit.request('GET /repos/{owner}/{repo}/actions/secrets/{secret_name}', {
      owner,
      repo,
      secret_name: SECRET_NAME,
    });
    return true;
  } catch (error) {
    if ((error as { status?: number } | undefined)?.status === 404) return false;
    throw error;
  }
}

// Delegates the libsodium sealed-box encryption GitHub requires to the gh CLI (wbfy already shells
// out to `gh auth token`, and #1094 removed the libsodium dependency for good). The token goes via
// stdin — never argv, which leaks into `ps` output and shell history.
function ghSecretSet(owner: string, repo: string, token: string): void {
  try {
    childProcess.execFileSync('gh', ['secret', 'set', SECRET_NAME, '--repo', `${owner}/${repo}`], {
      input: token,
      stdio: ['pipe', 'ignore', 'pipe'],
      encoding: 'utf8',
      // Reuse wbfy's credential selection (org PAT first, gh auth fallback) instead of whatever
      // account gh happens to be logged in as.
      env: { ...process.env, GH_TOKEN: getGitHubToken(owner) ?? '' },
    });
  } catch (error) {
    throw new Error(
      `\`gh secret set ${SECRET_NAME}\` failed (is the GitHub CLI installed and the credential authorized for ${owner}/${repo}?): ${(error as Error | undefined)?.message ?? error}`
    );
  }
}

// Decrypts ENCRYPTED_VERDACCIO_TOKEN with the CI age identity by running `fnox get` on a minimal
// fnox.toml in a temporary directory OUTSIDE any repository (so fnox's parent search finds nothing
// else), with an isolated HOME and all FNOX_* variables stripped, so ONLY the CI key can
// contribute to decryption. Returns undefined — without logging — when this machine simply lacks
// the CI identity; the caller decides whether that is an error.
function decryptEmbeddedVerdaccioToken(repoDirPath: string): string | undefined {
  const ciAgeKey = readCiAgeSecretKey();
  if (!ciAgeKey) return undefined;
  const tempDirPath = fs.mkdtempSync(path.join(os.tmpdir(), 'wbfy-verdaccio-'));
  const emptyHomeDirPath = path.join(tempDirPath, 'home');
  // Resolve a possible mise shim to the real fnox binary BEFORE isolating HOME: the shim refuses
  // to run once mise loses its trust state under the isolated HOME.
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
${SECRET_NAME} = { provider = "age", value = "${ENCRYPTED_VERDACCIO_TOKEN}" }
`
    );
    const env = {
      ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('FNOX_'))),
      FNOX_AGE_KEY: ciAgeKey,
      HOME: emptyHomeDirPath,
      XDG_CONFIG_HOME: emptyHomeDirPath,
    };
    const proc = childProcess.spawnSync(fnoxCommand, ['get', '--no-daemon', SECRET_NAME], {
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
        `Cannot decrypt the embedded ${SECRET_NAME} because the fnox command (${fnoxCommand}) could not be executed. Install fnox globally (e.g. \`mise use -g fnox\`). Reported: ${(proc.error?.message ?? proc.stderr ?? '').trim()}`
      );
      return undefined;
    }
    // `fnox get` appends a newline; the token itself never contains one.
    const token = proc.status === 0 ? proc.stdout.replace(/\n+$/u, '') : '';
    if (!token) {
      console.error(
        `The CI age key cannot decrypt the embedded ${SECRET_NAME}. Re-encrypt it for the CI recipient (see the comment on ENCRYPTED_VERDACCIO_TOKEN) and release wbfy. fnox reported:\n${(proc.stderr || '').trim()}`
      );
      return undefined;
    }
    return token;
  } finally {
    fs.rmSync(tempDirPath, { recursive: true, force: true });
  }
}

function readCiAgeSecretKey(): string | undefined {
  // The CI-dedicated identity is separate from the personal one (~/.config/fnox/age.txt) so that
  // the personal key never leaves the local machine and the CI key can be rotated independently.
  const identityPath = path.join(os.homedir(), '.config', 'fnox', 'age-ci-wb.txt');
  let content: string;
  try {
    content = fs.readFileSync(identityPath, 'utf8');
  } catch {
    // Missing identity is the normal state on most machines (agents, contributors); the caller
    // reports an error only when provisioning is actually required and impossible.
    return undefined;
  }
  // Require the `# public key:` comment (age-keygen always writes it) and verify it against the
  // CI entry exactly: skipping the check when the comment is absent would let a hand-assembled
  // file containing an arbitrary private key drive the upload, and matching any recipient would
  // let a personal identity copied to this path decide fleet-wide provisioning.
  const ciPublicKey = FNOX_AGE_RECIPIENTS.find((recipient) => recipient.name === 'ci')?.publicKey ?? '';
  const lines = content.split('\n');
  const commentedPublicKeys = lines
    .filter((line) => line.includes('public key:'))
    .map((line) => line.split('public key:')[1]?.trim());
  if (!ciPublicKey || !commentedPublicKeys.includes(ciPublicKey)) {
    console.error(
      `The \`# public key:\` comment in ${identityPath} is missing or differs from the CI age public key (${ciPublicKey}), so the file does not hold the CI-dedicated identity.`
    );
    return undefined;
  }
  const keyLines = lines.map((line) => line.trim()).filter((line) => line.startsWith('AGE-SECRET-KEY-'));
  return keyLines.length > 0 ? keyLines.join('\n') : undefined;
}
