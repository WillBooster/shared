import child_process from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { parse } from 'smol-toml';

import { logger } from '../logger.js';
import type { PackageConfig } from '../packageConfig.js';
import { fsUtil } from '../utils/fsUtil.js';

// The age public keys of every developer and of CI. Every fnox-managed repository must encrypt
// its secrets for exactly this recipient set so that decryptability does not depend on which
// machine ran wbfy. To grant a new member or environment access, append its public key here; the
// next wbfy run on each repository rewrites the recipients in fnox.toml and re-encrypts the
// committed secrets. Only public keys may appear in this repository; CI's private key lives in
// ~/.config/fnox/ci-age.txt and the FNOX_AGE_KEY repository secrets.
export const FNOX_AGE_RECIPIENTS = [
  { name: 'exkazuu', publicKey: 'age1j2354xhvm3fv9y77t5g6y3q8mexgk2mf00tgrkzgp73tynrvz55s8auayw' },
  { name: 'ci', publicKey: 'age1a2c6ef6ahl6mmkhgqtxg0mgtd7ysspntq7rxusv26efxhnuhlcdsr9dpak' },
];

interface FnoxToml {
  import?: unknown;
  providers?: Record<string, Record<string, unknown> | undefined>;
  profiles?: Record<string, Record<string, unknown> | undefined>;
  [key: string]: unknown;
}

let fnoxSyncFailed = false;
let migrationMarkerPath: string | undefined;
let migrationMarkerOwned = false;

/** Whether any fnox recipient synchronization failed in the current repository; setupSecrets must not upload then. */
export function hasFnoxSyncFailed(): boolean {
  return fnoxSyncFailed;
}

/**
 * Synchronizes the age recipients in every fnox.toml with FNOX_AGE_RECIPIENTS and re-encrypts the
 * committed secrets when the recipient set changed.
 */
export async function generateFnoxToml(rootConfig: PackageConfig): Promise<void> {
  return logger.functionIgnoringException('generateFnoxToml', async () => {
    // The failure flag is per repository: wbfy can process multiple working directories in one
    // invocation, and an earlier repository's failure must not veto a later repository's upload.
    fnoxSyncFailed = false;
    const rootDirPath = path.resolve(rootConfig.dirPath);
    if (!fs.existsSync(path.resolve(rootDirPath, 'fnox.toml'))) {
      // A nested-only fnox layout is unsupported: setupSecrets would take the dotenv path and
      // delete FNOX_AGE_KEY even though the nested config's CI still needs it.
      try {
        const strayFilePaths = listFnoxLikeFilePaths(rootDirPath);
        if (strayFilePaths.length > 0) {
          failFnoxSync(
            `Failed to synchronize fnox age recipients because fnox configs exist without a root fnox.toml: ${strayFilePaths.join(', ')}. Add a root fnox.toml.`
          );
        }
      } catch (error) {
        // Fail closed: without git information a nested-only fnox layout cannot be ruled out, and
        // setupSecrets would otherwise take the dotenv path and delete FNOX_AGE_KEY.
        failFnoxSync(
          `Failed to check for nested fnox configs due to: ${(error as Error | undefined)?.message ?? error}`
        );
      }
      return;
    }
    // The migration is transactional over every managed fnox.toml: reruns must retry from the
    // original state, and a partially migrated tree could otherwise become undecryptable for the
    // identity performing a later retry (e.g. when a recipient is being removed).
    const snapshots = new Map<string, string>();
    // A failed synchronization must fail the whole wbfy run: exiting zero with stale recipients
    // would leave secrets undecryptable for new recipients while looking successful.
    try {
      // Any fnox config (including aliases and local overrides) in an ancestor directory would
      // merge into (and possibly be REWRITTEN by) this repository's `fnox reencrypt` through
      // hierarchical loading, using this repository's recipient set for foreign secrets.
      for (let dirPath = path.dirname(rootDirPath); ; dirPath = path.dirname(dirPath)) {
        const ancestorFnoxFileNames = listFnoxLikeFileNames(dirPath);
        if (ancestorFnoxFileNames.length > 0) {
          failFnoxSync(
            `Failed to synchronize fnox age recipients because an ancestor directory contains fnox configs that fnox would hierarchically merge and rewrite: ${ancestorFnoxFileNames
              .map((name) => path.join(dirPath, name))
              .join(', ')}. Remove them or move the repository.`
          );
          return;
        }
        if (path.dirname(dirPath) === dirPath) break;
      }
      // fnox also loads committed config aliases this generator cannot keep in sync.
      const unsupportedFilePaths = listFnoxLikeFilePaths(rootDirPath).filter(
        (filePath) => path.basename(filePath) !== 'fnox.toml'
      );
      if (unsupportedFilePaths.length > 0) {
        failFnoxSync(
          `Failed to synchronize fnox age recipients because only fnox.toml files are supported: ${unsupportedFilePaths.join(', ')}. Merge them into the adjacent fnox.toml.`
        );
        return;
      }
      const dirPaths = listFnoxTomlDirPaths(rootDirPath);
      if (!dirPaths.includes(rootDirPath)) {
        failFnoxSync(
          `Failed to synchronize fnox age recipients because ${path.resolve(rootDirPath, 'fnox.toml')} is invisible to git (gitignored?). Commit it or remove it.`
        );
        return;
      }
      // Git-based discovery cannot see gitignored files, so also inspect every directory in each
      // managed config's hierarchy through the filesystem: a gitignored alias (e.g. .fnox.toml)
      // or a gitignored fnox.toml in an intermediate directory would still be loaded by fnox and
      // could override the provider used for nested re-encryption.
      const managedDirPaths = new Set(dirPaths);
      for (const dirPath of dirPaths) {
        for (const hierarchyDirPath of listAncestorDirPaths(dirPath, rootDirPath)) {
          const strayFileNames = listFnoxLikeFileNames(hierarchyDirPath).filter(
            (name) => name !== 'fnox.local.toml' && !(name === 'fnox.toml' && managedDirPaths.has(hierarchyDirPath))
          );
          if (strayFileNames.length > 0) {
            failFnoxSync(
              `Failed to synchronize fnox age recipients because fnox would load unmanaged (gitignored?) configs: ${strayFileNames
                .map((name) => path.join(hierarchyDirPath, name))
                .join(', ')}. Commit them as fnox.toml or remove them.`
            );
            return;
          }
          // A fnox.local.toml anywhere in the merged hierarchy (not only next to a managed
          // config) can override providers.
          const localIssue = findFnoxLocalTomlIssue(hierarchyDirPath);
          if (localIssue) {
            failFnoxSync(
              `Failed to synchronize fnox age recipients because ${localIssue}. Keep only machine-local secret overrides there.`
            );
            return;
          }
        }
      }
      // The in-memory snapshots do not survive a killed process, so a durable marker is written
      // before the first mutation and removed only when the tree is consistent again. A leftover
      // marker means a previous run was killed mid-migration (or could not restore): some
      // ciphertexts may not match the recipients, or may even be undecryptable for the executor's
      // identity when a recipient was being removed — states this code cannot repair safely
      // because the working tree may have changed since (branch switches, manual edits). The
      // fnox.toml files are git-tracked, so the user restores them via git and clears the marker.
      migrationMarkerPath = path.resolve(rootDirPath, '.tmp', 'wbfy-fnox-migration-marker');
      if (fs.existsSync(migrationMarkerPath)) {
        failFnoxSync(
          `Failed to synchronize fnox age recipients because a previous migration was interrupted. Restore the fnox.toml files via git (e.g. \`git status\` and \`git restore -- '*fnox*.toml'\` if you have no intentional local changes), then delete ${migrationMarkerPath} and rerun wbfy.`
        );
        return;
      }

      // A tracked symlink named fnox.toml (or a symlinked parent directory) would make the
      // rewrite and `fnox reencrypt` read and MODIFY files outside this repository.
      const realRootDirPath = fs.realpathSync(rootDirPath);
      for (const dirPath of dirPaths) {
        const fnoxTomlPath = path.resolve(dirPath, 'fnox.toml');
        const realPath = fs.realpathSync(fnoxTomlPath);
        if (
          fs.lstatSync(fnoxTomlPath).isSymbolicLink() ||
          (realPath !== path.join(realRootDirPath, 'fnox.toml') && !realPath.startsWith(realRootDirPath + path.sep))
        ) {
          failFnoxSync(
            `Failed to synchronize fnox age recipients because ${fnoxTomlPath} is a symlink or resolves outside the repository (${realPath}). Replace it with a regular in-repository file.`
          );
          return;
        }
        snapshots.set(fnoxTomlPath, fs.readFileSync(fnoxTomlPath, 'utf8'));
      }

      // Sorted order processes ancestors before descendants, so configs inheriting an updated
      // provider re-encrypt against the already-updated recipients.
      const changedDirPaths: string[] = [];
      let anyFailed = false;
      for (const dirPath of dirPaths) {
        const ancestorChanged = changedDirPaths.some((changedDirPath) => dirPath.startsWith(changedDirPath + path.sep));
        const result = await synchronizeFnoxAgeRecipients(
          dirPath,
          rootDirPath,
          dirPath === rootDirPath,
          ancestorChanged
        );
        if (result === 'changed') changedDirPaths.push(dirPath);
        anyFailed ||= result === 'failed';
      }
      if (anyFailed) {
        // A failed re-encryption may have rewritten some ciphertexts, so restore unconditionally.
        // The marker is removed only when restoration fully succeeded and the tree is consistent.
        // Restore ONLY when this run owns the marker: every committed-config mutation happens
        // after marker acquisition, so a non-owner (e.g. losing a race against a concurrent wbfy)
        // has changed nothing and must not overwrite the owner's in-progress migration.
        if (migrationMarkerOwned && restoreSnapshots(snapshots)) removeOwnedMigrationMarker();
      } else {
        removeOwnedMigrationMarker();
      }
    } catch (error) {
      if (migrationMarkerOwned && restoreSnapshots(snapshots)) {
        removeOwnedMigrationMarker();
      }
      failFnoxSync(`Failed to synchronize fnox age recipients due to: ${(error as Error | undefined)?.stack ?? error}`);
    } finally {
      migrationMarkerPath = undefined;
      migrationMarkerOwned = false;
    }
  });
}

async function synchronizeFnoxAgeRecipients(
  dirPath: string,
  rootDirPath: string,
  isRoot: boolean,
  ancestorRecipientsChanged: boolean
): Promise<'changed' | 'unchanged' | 'failed'> {
  const fnoxTomlPath = path.resolve(dirPath, 'fnox.toml');

  // Recipient synchronization only understands the standard single-file layout with one
  // top-level age provider named `age`. Gitignored config aliases (e.g. .fnox.local.toml) that
  // git-based discovery cannot see, imports, differently named age providers, or provider
  // overrides would keep using recipient sets this generator does not rewrite, so their secrets
  // would silently stay undecryptable for new recipients; fail instead of proceeding. The
  // gitignored fnox.local.toml is a supported machine-local override, but only while it leaves
  // providers alone.
  const unsupportedFileNames = listFnoxLikeFileNames(dirPath).filter(
    (name) => name !== 'fnox.toml' && name !== 'fnox.local.toml'
  );
  if (unsupportedFileNames.length > 0) {
    failFnoxSync(
      `Failed to synchronize fnox age recipients in ${dirPath} because only fnox.toml and fnox.local.toml are supported: ${unsupportedFileNames.join(', ')}. Merge them into fnox.toml.`
    );
    return 'failed';
  }
  // A stale backup left by an interrupted earlier run must be restored so the user's local
  // overrides are never silently lost (the migration marker separately blocks this run when the
  // interruption left the migration itself incomplete).
  recoverStaleFnoxLocalBackup(rootDirPath, dirPath);

  const originalContent = fs.readFileSync(fnoxTomlPath, 'utf8');
  const layoutIssue = findFnoxLayoutIssue(originalContent);
  if (layoutIssue) {
    failFnoxSync(`Failed to synchronize fnox age recipients because ${fnoxTomlPath} ${layoutIssue}.`);
    return 'failed';
  }
  const settings = parse(originalContent) as FnoxToml;
  const profileNames = Object.keys(settings.profiles ?? {});
  const currentRecipients = readFnoxAgeRecipients(originalContent);

  // A nested fnox.toml without its own age provider inherits the nearest ancestor's one through
  // fnox's hierarchical loading, so only the root config must declare the provider — but the
  // nested config's own ciphertexts still must be re-encrypted whenever an ancestor's recipients
  // changed, and that only happens when `fnox reencrypt` runs from the nested directory.
  if (!isRoot && !currentRecipients) {
    if (ancestorRecipientsChanged) {
      writeMigrationMarker();
      if (!reencryptFnoxSecrets(dirPath, rootDirPath, profileNames)) {
        failFnoxSync(
          `Failed to re-encrypt fnox secrets in ${dirPath} for the updated recipients. Fix the error and rerun wbfy.`
        );
        return 'failed';
      }
    }
    return 'unchanged';
  }

  if (
    currentRecipients &&
    currentRecipients.size === FNOX_AGE_RECIPIENTS.length &&
    FNOX_AGE_RECIPIENTS.every((recipient) => currentRecipients.has(recipient.publicKey))
  ) {
    return 'unchanged';
  }

  // Rewrite only the recipients assignment so user-authored comments and formatting survive.
  // Re-parse before writing: an unusual layout (e.g. dotted keys) could make the textual edit
  // produce a duplicate table or leave the old recipients in effect.
  const updatedContent = replaceAgeRecipients(originalContent);
  const updatedRecipients = [...(readFnoxAgeRecipients(updatedContent) ?? [])];
  if (
    updatedRecipients.length !== FNOX_AGE_RECIPIENTS.length ||
    !FNOX_AGE_RECIPIENTS.every((recipient) => updatedRecipients.includes(recipient.publicKey))
  ) {
    throw new Error(`Rewriting the age recipients in ${fnoxTomlPath} did not take effect; update them manually.`);
  }
  writeMigrationMarker();
  await fsUtil.generateFile(fnoxTomlPath, updatedContent);

  if (!reencryptFnoxSecrets(dirPath, rootDirPath, profileNames)) {
    // Restore the original config: keeping the new recipients with old ciphertexts would make
    // this generator skip re-encryption forever and let setupSecrets upload a CI key that
    // cannot decrypt anything. The old ciphertexts remain valid for the old recipients.
    await fsUtil.generateFile(fnoxTomlPath, originalContent);
    failFnoxSync(
      `Failed to re-encrypt fnox secrets in ${dirPath} for the updated recipients. Fix the error and rerun wbfy.`
    );
    return 'failed';
  }
  return 'changed';
}

/**
 * Returns a description of a fnox.toml layout that recipient synchronization and the CI-key
 * verification cannot cover, or undefined when the standard single-file, single-age-provider
 * layout is used.
 */
export function findFnoxLayoutIssue(fnoxTomlContent: string): string | undefined {
  try {
    const settings = parse(fnoxTomlContent) as FnoxToml;
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

/**
 * Reads the [providers.age].recipients of a fnox.toml, or undefined when the config declares no
 * age provider (nested configs then inherit the root one).
 */
export function readFnoxAgeRecipients(fnoxTomlContent: string): Set<string> | undefined {
  try {
    const settings = parse(fnoxTomlContent) as FnoxToml;
    if (!settings.providers?.age) return undefined;
    const recipients = settings.providers.age.recipients;
    return new Set(Array.isArray(recipients) ? recipients.filter((r): r is string => typeof r === 'string') : []);
  } catch {
    // An unparsable fnox.toml yields no recipients, so the caller reports an error.
    return new Set();
  }
}

function replaceAgeRecipients(content: string): string {
  const recipientsText = `recipients = [${FNOX_AGE_RECIPIENTS.map((recipient) => `"${recipient.publicKey}"`).join(', ')}]`;
  // Standard form: a [providers.age] table (possibly with a trailing comment). Scan line-wise so
  // that a `[` inside a comment or a string never terminates the table early; the table ends at
  // the next line-start table header. The assignment match is line-anchored so a commented-out
  // `# recipients = [...]` is never mistaken for the real one. Known accepted limitation: a `]`
  // inside a comment within a multiline recipients array defeats the match — the re-parse
  // validation in the caller then fails the run safely with instructions instead of corrupting
  // the file.
  const lines = content.split('\n');
  const headerIndex = lines.findIndex((line) => /^\s*\[\s*providers\.age\s*\]\s*(?:#.*)?$/u.test(line));
  if (headerIndex !== -1) {
    let endIndex = lines.length;
    for (let index = headerIndex + 1; index < lines.length; index++) {
      if (/^\s*\[/u.test(lines[index] ?? '')) {
        endIndex = index;
        break;
      }
    }
    const section = lines.slice(headerIndex, endIndex).join('\n');
    const replacedSection = section.replace(/^\s*recipients\s*=\s*\[[^\]]*\]/mu, recipientsText);
    const newSection =
      replacedSection === section
        ? [lines[headerIndex], recipientsText, ...lines.slice(headerIndex + 1, endIndex)].join('\n')
        : replacedSection;
    return [...lines.slice(0, headerIndex), newSection, ...lines.slice(endIndex)].join('\n');
  }
  // Inline form: age = { type = "age", recipients = [...] } inside a [providers] table.
  const withReplacedInline = content.replace(
    /(\bage\s*=\s*\{[^}]*?)recipients\s*=\s*\[[^\]]*\]/u,
    `$1${recipientsText}`
  );
  if (withReplacedInline !== content) return withReplacedInline;
  return `${content.trimEnd()}\n\n[providers.age]\ntype = "age"\n${recipientsText}\n`;
}

// Re-encrypts the base secrets and each profile's own secrets (--no-defaults keeps the merged
// base secrets from being duplicated into profile tables) for the current recipient set. The
// spawned fnox runs with an isolated HOME/XDG_CONFIG_HOME because fnox merges the user-global
// ~/.config/fnox/config.toml into every project config — a plain reencrypt would rewrite the
// user's global secrets too. Decryption therefore needs the personal identity passed explicitly
// via FNOX_AGE_KEY; FNOX_PROFILE is stripped so it cannot redirect the base (no -P) run.
function reencryptFnoxSecrets(dirPath: string, rootDirPath: string, profileNames: string[]): boolean {
  // The identity is optional: a plaintext-only config has nothing to decrypt and fnox succeeds
  // without one, while existing ciphertexts make fnox fail loudly on its own.
  const identity = readPersonalAgeSecretKey() ?? process.env.FNOX_AGE_KEY;
  const fnoxCommand = resolveFnoxCommand(dirPath);
  const isolatedHomeDirPath = fs.mkdtempSync(path.join(os.tmpdir(), 'wbfy-fnox-home-'));
  try {
    // Hide the local overrides of EVERY directory fnox merges hierarchically (from the command
    // directory up to the repository root): an ancestor's fnox.local.toml would otherwise shadow
    // committed secrets or itself get rewritten by the re-encryption.
    return withFnoxLocalsHidden(rootDirPath, listAncestorDirPaths(dirPath, rootDirPath), () => {
      const env = {
        ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('FNOX_'))),
        ...(identity ? { FNOX_AGE_KEY: identity } : {}),
        HOME: isolatedHomeDirPath,
        XDG_CONFIG_HOME: isolatedHomeDirPath,
      };
      const profileArgsList = [[], ...profileNames.map((name) => ['--no-defaults', `--profile=${name}`])];
      for (const profileArgs of profileArgsList) {
        const args = ['reencrypt', '--force', '--no-daemon', '--provider', 'age', ...profileArgs];
        console.log(`$ ${fnoxCommand} ${args.join(' ')} at ${dirPath}`);
        const proc = child_process.spawnSync(fnoxCommand, args, {
          cwd: dirPath,
          encoding: 'utf8',
          stdio: 'inherit',
          env,
        });
        if ((proc.status ?? 1) !== 0) return false;
      }
      return true;
    });
  } finally {
    fs.rmSync(isolatedHomeDirPath, { recursive: true, force: true });
  }
}

/**
 * Resolves the actual fnox binary. `fnox` on PATH is often a mise shim, and mise refuses to run
 * once HOME/XDG_CONFIG_HOME point at the isolated directory (its trust state disappears), so the
 * isolated spawns need the shim resolved to the real executable beforehand.
 */
export function resolveFnoxCommand(dirPath: string): string {
  const proc = child_process.spawnSync('mise', ['which', 'fnox'], { cwd: dirPath, encoding: 'utf8', stdio: 'pipe' });
  const resolved = proc.status === 0 ? proc.stdout.trim() : '';
  return resolved || 'fnox';
}

function readPersonalAgeSecretKey(): string | undefined {
  try {
    const content = fs.readFileSync(path.join(os.homedir(), '.config', 'fnox', 'age.txt'), 'utf8');
    return content
      .split('\n')
      .find((line) => line.trim().startsWith('AGE-SECRET-KEY-'))
      ?.trim();
  } catch {
    return undefined;
  }
}

/**
 * Runs a function while the machine-local fnox.local.toml files of the given directories are
 * temporarily moved aside: fnox loads them at higher priority than the committed fnox.toml, so a
 * local override shadowing a committed secret would make `fnox reencrypt` skip that secret.
 */
function withFnoxLocalsHidden<T>(rootDirPath: string, dirPaths: string[], func: () => T): T {
  const hiddenDirPaths: string[] = [];
  try {
    for (const dirPath of dirPaths) {
      recoverStaleFnoxLocalBackup(rootDirPath, dirPath);
      const localPath = path.resolve(dirPath, 'fnox.local.toml');
      if (fs.existsSync(localPath)) {
        const backupPath = fnoxLocalBackupPath(rootDirPath, dirPath);
        ensureSafeFnoxLocalBackupDir(rootDirPath, backupPath);
        fs.renameSync(localPath, backupPath);
        hiddenDirPaths.push(dirPath);
      }
    }
    const result = func();
    // A restoration conflict throws here and thereby invalidates the seemingly successful result:
    // a recreated override may have shadowed committed secrets during the fnox run, so the outer
    // transaction must restore every committed fnox.toml instead of committing the migration.
    restoreHiddenFnoxLocals(rootDirPath, hiddenDirPaths);
    return result;
  } catch (error) {
    // The original failure must win; a restoration conflict on this path is only reported so it
    // cannot mask the root cause.
    try {
      restoreHiddenFnoxLocals(rootDirPath, hiddenDirPaths);
    } catch (restoreError) {
      failFnoxSync((restoreError as Error | undefined)?.message ?? String(restoreError));
    }
    throw error;
  }
}

// Moves the hidden fnox.local.toml files back, clearing the given list so a second call is a
// no-op. Never clobbers a fnox.local.toml recreated (e.g. by an editor) while fnox was running:
// the backup is kept and reported for a manual merge.
function restoreHiddenFnoxLocals(rootDirPath: string, hiddenDirPaths: string[]): void {
  const conflictingLocalPaths: string[] = [];
  for (const dirPath of hiddenDirPaths.splice(0)) {
    const localPath = path.resolve(dirPath, 'fnox.local.toml');
    if (fs.existsSync(localPath)) {
      conflictingLocalPaths.push(localPath);
      continue;
    }
    fs.renameSync(fnoxLocalBackupPath(rootDirPath, dirPath), localPath);
  }
  if (conflictingLocalPaths.length > 0) {
    throw new Error(
      `The following fnox.local.toml files were recreated while fnox was running (original files are preserved under ${path.resolve(rootDirPath, '.tmp', 'wbfy-fnox-local-backup')} — merge them manually): ${conflictingLocalPaths.join(', ')}`
    );
  }
}

/**
 * Restores a fnox.local.toml backup left by an interrupted earlier run so the user's local
 * overrides are never silently lost.
 */
function recoverStaleFnoxLocalBackup(rootDirPath: string, dirPath: string): void {
  const localPath = path.resolve(dirPath, 'fnox.local.toml');
  const backupPath = fnoxLocalBackupPath(rootDirPath, dirPath);
  if (!fs.existsSync(backupPath)) return;
  if (fs.existsSync(localPath)) {
    throw new Error(`Both ${localPath} and its backup ${backupPath} exist; resolve the leftover backup manually.`);
  }
  ensureSafeFnoxLocalBackupDir(rootDirPath, backupPath);
  fs.renameSync(backupPath, localPath);
}

// Creates the backup directory and proves no path component below the repository root is a
// symlink: a repository-controlled symlink (e.g. a tracked .tmp/wbfy-fnox-local-backup link)
// could otherwise move the plaintext local secrets outside the repository, or resolve the backup
// back onto the source file and turn the hide rename into a no-op.
function ensureSafeFnoxLocalBackupDir(rootDirPath: string, backupPath: string): void {
  const backupDirPath = path.dirname(backupPath);
  fs.mkdirSync(backupDirPath, { recursive: true });
  const expectedRealPath = path.join(fs.realpathSync(rootDirPath), path.relative(rootDirPath, backupDirPath));
  if (fs.realpathSync(backupDirPath) !== expectedRealPath) {
    throw new Error(`${backupDirPath} resolves through a symlink; remove the symlinked component.`);
  }
}

// The backup lives under the gitignored .tmp so a hidden fnox.local.toml can never become
// stageable (a sibling rename like fnox.local.toml.wbfy-bak would no longer match the documented
// `fnox.local.toml` ignore entry and could be committed by `git add -A`).
function fnoxLocalBackupPath(rootDirPath: string, dirPath: string): string {
  return path.resolve(
    rootDirPath,
    '.tmp',
    'wbfy-fnox-local-backup',
    path.relative(rootDirPath, dirPath),
    'fnox.local.toml'
  );
}

function writeMigrationMarker(): void {
  if (!migrationMarkerPath || migrationMarkerOwned) return;
  const tmpDirPath = path.dirname(migrationMarkerPath);
  fs.mkdirSync(tmpDirPath, { recursive: true });
  // Refuse to write through symlinks: a repository-controlled .tmp symlink could otherwise
  // redirect the marker write outside the repository. The `wx` flag makes the open itself fail
  // on any pre-existing path, including a dangling symlink — which also acquires the marker
  // atomically, so a concurrent wbfy run cannot start a second migration.
  if (fs.lstatSync(tmpDirPath).isSymbolicLink()) {
    throw new Error(`${tmpDirPath} is a symlink; replace it with a regular directory.`);
  }
  try {
    fs.writeFileSync(
      migrationMarkerPath,
      'wbfy fnox migration in progress; a leftover marker blocks new migrations\n',
      {
        flag: 'wx',
      }
    );
  } catch (error) {
    throw new Error(`Another wbfy process appears to be migrating (${migrationMarkerPath} exists): ${error}`);
  }
  migrationMarkerOwned = true;
}

// Only the run that acquired the marker may remove it: deleting a foreign marker would disable
// interrupted-migration detection for a concurrently running wbfy.
function removeOwnedMigrationMarker(): void {
  if (!migrationMarkerOwned || !migrationMarkerPath) return;
  fs.rmSync(migrationMarkerPath, { force: true });
  migrationMarkerOwned = false;
}

function restoreSnapshots(snapshots: Map<string, string>): boolean {
  let succeeded = true;
  for (const [filePath, content] of snapshots) {
    try {
      fs.writeFileSync(filePath, content);
    } catch (error) {
      failFnoxSync(`Failed to restore ${filePath} after a failed migration: ${error}`);
      succeeded = false;
    }
  }
  return succeeded;
}

function failFnoxSync(message: string): void {
  console.error(message);
  process.exitCode = 1;
  fnoxSyncFailed = true;
}

// Returns a description of an unsupported fnox.local.toml in the directory, or undefined. Local
// overrides may only hold machine-local secret values; imports or provider (re)definitions would
// silently change which recipient set governs re-encryption.
function findFnoxLocalTomlIssue(dirPath: string): string | undefined {
  const localTomlPath = path.resolve(dirPath, 'fnox.local.toml');
  if (!fs.existsSync(localTomlPath)) return undefined;
  const localSettings = parse(fs.readFileSync(localTomlPath, 'utf8')) as FnoxToml;
  const definesProviders =
    localSettings.import !== undefined ||
    localSettings.providers !== undefined ||
    Object.values(localSettings.profiles ?? {}).some((profile) => profile?.providers !== undefined);
  return definesProviders ? `${localTomlPath} defines imports, providers, or profile providers` : undefined;
}

/**
 * Lists every directory in the repository containing a committed (or committable) fnox.toml.
 * Discovery goes through git so that gitignored trees (node_modules, build outputs) are excluded
 * without excluding legitimate packages that merely happen to be named like build outputs.
 */
function listFnoxTomlDirPaths(rootDirPath: string): string[] {
  return [
    ...new Set(
      listFnoxLikeFilePaths(rootDirPath)
        .filter((filePath) => path.basename(filePath) === 'fnox.toml')
        .map((filePath) => path.dirname(filePath))
    ),
  ].toSorted();
}

function listFnoxLikeFilePaths(rootDirPath: string): string[] {
  // -z prints NUL-delimited verbatim paths; without it, core.quotePath C-quotes non-ASCII paths
  // (e.g. "\346\227\245..."), which would make the basename filter silently skip those configs.
  const proc = child_process.spawnSync(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', '*fnox*.toml'],
    { cwd: rootDirPath, encoding: 'utf8', stdio: 'pipe' }
  );
  // Fail closed: treating a git failure as "no fnox configs" would skip synchronization and let
  // setupSecrets upload a key that was never verified against the repository's ciphertexts.
  if (proc.status !== 0) {
    throw new Error(`git ls-files failed in ${rootDirPath}: ${(proc.stderr || proc.error?.message || '').trim()}`);
  }
  return proc.stdout
    .split('\0')
    .filter((line) => /^\.?fnox(\..+)?\.toml$/u.test(path.basename(line)))
    .map((line) => path.resolve(rootDirPath, line));
}

function listFnoxLikeFileNames(dirPath: string): string[] {
  try {
    return fs
      .readdirSync(dirPath)
      .filter((name) => /^\.?fnox(\..+)?\.toml$/u.test(name))
      .toSorted();
  } catch (error) {
    if ((error as { code?: string } | undefined)?.code === 'ENOENT') return [];
    // Fail closed: fnox can still load a config from a directory this process cannot enumerate
    // (e.g. execute-only permission), so an enumeration failure must not read as "no configs".
    throw new Error(`Cannot inspect ${dirPath} for fnox configs: ${error}`);
  }
}

function listAncestorDirPaths(dirPath: string, rootDirPath: string): string[] {
  const dirPaths = [dirPath];
  while (dirPaths.at(-1) !== rootDirPath) {
    const parent = path.dirname(dirPaths.at(-1) ?? '');
    if (parent === dirPaths.at(-1)) break;
    dirPaths.push(parent);
  }
  return dirPaths;
}
