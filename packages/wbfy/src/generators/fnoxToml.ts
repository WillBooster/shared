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

/** Whether any fnox recipient synchronization failed in the current repository; setupSecrets must not upload then. */
export function hasFnoxSyncFailed(): boolean {
  return fnoxSyncFailed;
}

/**
 * Lists every directory in the repository containing a committed (or committable) fnox.toml.
 * Discovery goes through git so that gitignored trees (node_modules, build outputs) are excluded
 * without excluding legitimate packages that merely happen to be named like build outputs.
 */
export function listFnoxTomlDirPaths(rootDirPath: string): string[] {
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

/** Reads the profile names declared in a fnox.toml (empty when the file is absent). */
export function readFnoxProfileNames(dirPath: string): string[] {
  const fnoxTomlPath = path.resolve(dirPath, 'fnox.toml');
  if (!fs.existsSync(fnoxTomlPath)) return [];
  const settings = parse(fs.readFileSync(fnoxTomlPath, 'utf8')) as FnoxToml;
  return Object.keys(settings.profiles ?? {});
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
      } catch {
        // Without git information there is nothing fnox-managed to protect here.
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
      // A fnox.toml in an ancestor directory would merge into (and be REWRITTEN by) this
      // repository's `fnox reencrypt` through hierarchical loading, using this repository's
      // recipient set for foreign secrets.
      for (let dirPath = path.dirname(rootDirPath); ; dirPath = path.dirname(dirPath)) {
        if (fs.existsSync(path.join(dirPath, 'fnox.toml'))) {
          failFnoxSync(
            `Failed to synchronize fnox age recipients because an ancestor directory contains a fnox.toml that fnox would hierarchically merge and rewrite: ${path.join(dirPath, 'fnox.toml')}. Remove it or move the repository.`
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
      for (const dirPath of dirPaths) {
        const fnoxTomlPath = path.resolve(dirPath, 'fnox.toml');
        snapshots.set(fnoxTomlPath, fs.readFileSync(fnoxTomlPath, 'utf8'));
      }

      // Sorted order processes ancestors before descendants, so configs inheriting an updated
      // provider re-encrypt against the already-updated recipients.
      const changedDirPaths: string[] = [];
      let anyFailed = false;
      for (const dirPath of dirPaths) {
        const ancestorChanged = changedDirPaths.some((changedDirPath) => dirPath.startsWith(changedDirPath + path.sep));
        const result = await synchronizeFnoxAgeRecipients(dirPath, dirPath === rootDirPath, ancestorChanged);
        if (result === 'changed') changedDirPaths.push(dirPath);
        anyFailed ||= result === 'failed';
      }
      if (anyFailed && changedDirPaths.length > 0) {
        restoreSnapshots(snapshots);
      }
    } catch (error) {
      restoreSnapshots(snapshots);
      failFnoxSync(`Failed to synchronize fnox age recipients due to: ${(error as Error | undefined)?.stack ?? error}`);
    }
  });
}

function restoreSnapshots(snapshots: Map<string, string>): void {
  for (const [filePath, content] of snapshots) {
    try {
      fs.writeFileSync(filePath, content);
    } catch (error) {
      failFnoxSync(`Failed to restore ${filePath} after a failed migration: ${error}`);
    }
  }
}

function failFnoxSync(message: string): void {
  console.error(message);
  process.exitCode = 1;
  fnoxSyncFailed = true;
}

async function synchronizeFnoxAgeRecipients(
  dirPath: string,
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
  const unsupportedFileNames = fs
    .readdirSync(dirPath)
    .filter((name) => /^\.?fnox(\..+)?\.toml$/u.test(name) && name !== 'fnox.toml' && name !== 'fnox.local.toml')
    .toSorted();
  if (unsupportedFileNames.length > 0) {
    failFnoxSync(
      `Failed to synchronize fnox age recipients in ${dirPath} because only fnox.toml and fnox.local.toml are supported: ${unsupportedFileNames.join(', ')}. Merge them into fnox.toml.`
    );
    return 'failed';
  }
  // A stale backup left by an interrupted earlier run means the last re-encryption may not have
  // completed; restore the user's local overrides and force a re-encryption below.
  const recoveredLocalBackup = recoverStaleFnoxLocalBackup(dirPath);
  const localTomlPath = path.resolve(dirPath, 'fnox.local.toml');
  if (fs.existsSync(localTomlPath)) {
    const localSettings = parse(fs.readFileSync(localTomlPath, 'utf8')) as FnoxToml;
    const definesProviders =
      localSettings.import !== undefined ||
      localSettings.providers !== undefined ||
      Object.values(localSettings.profiles ?? {}).some((profile) => profile?.providers !== undefined);
    if (definesProviders) {
      failFnoxSync(
        `Failed to synchronize fnox age recipients in ${dirPath} because fnox.local.toml defines imports, providers, or profile providers, which this generator cannot keep in sync. Keep only machine-local secret overrides there.`
      );
      return 'failed';
    }
  }

  // A parse failure must abort instead of falling back to {}: regenerating from an empty object
  // would silently drop the committed encrypted secrets.
  const originalContent = fs.readFileSync(fnoxTomlPath, 'utf8');
  const settings = parse(originalContent) as FnoxToml;
  if (settings.import !== undefined) {
    failFnoxSync(
      `Failed to synchronize fnox age recipients in ${dirPath} because \`import\` is not supported. Merge the imported files into fnox.toml.`
    );
    return 'failed';
  }
  const nonStandardAgeProviderNames = Object.entries(settings.providers ?? {})
    .filter(([name, provider]) => (provider?.type === 'age') !== (name === 'age'))
    .map(([name]) => name);
  if (nonStandardAgeProviderNames.length > 0) {
    failFnoxSync(
      `Failed to synchronize fnox age recipients in ${dirPath} because age providers must be named \`age\` (and \`age\` must have type "age"): ${nonStandardAgeProviderNames.join(', ')}. Rename them.`
    );
    return 'failed';
  }
  const profilesWithProviders = Object.entries(settings.profiles ?? {})
    .filter(([, profile]) => profile?.providers)
    .map(([name]) => name);
  if (profilesWithProviders.length > 0) {
    failFnoxSync(
      `Failed to synchronize fnox age recipients in ${dirPath} because profile-specific providers are not supported: ${profilesWithProviders.join(', ')}. Move them to the top-level [providers] table.`
    );
    return 'failed';
  }

  const profileNames = Object.keys(settings.profiles ?? {});

  // A nested fnox.toml without its own age provider inherits the nearest ancestor's one through
  // fnox's hierarchical loading, so only the root config must declare the provider — but the
  // nested config's own ciphertexts still must be re-encrypted whenever an ancestor's recipients
  // changed, and that only happens when `fnox reencrypt` runs from the nested directory.
  if (!isRoot && !settings.providers?.age) {
    if ((ancestorRecipientsChanged || recoveredLocalBackup) && !reencryptFnoxSecrets(dirPath, profileNames)) {
      failFnoxSync(
        `Failed to re-encrypt fnox secrets in ${dirPath} for the updated recipients. Fix the error and rerun wbfy.`
      );
      return 'failed';
    }
    return 'unchanged';
  }

  const ageProvider = settings.providers?.age ?? {};
  const currentRecipients = new Set(Array.isArray(ageProvider.recipients) ? ageProvider.recipients : []);
  if (
    currentRecipients.size === FNOX_AGE_RECIPIENTS.length &&
    FNOX_AGE_RECIPIENTS.every((recipient) => currentRecipients.has(recipient.publicKey))
  ) {
    if (recoveredLocalBackup && !reencryptFnoxSecrets(dirPath, profileNames)) {
      failFnoxSync(
        `Failed to re-encrypt fnox secrets in ${dirPath} after an interrupted earlier run. Fix the error and rerun wbfy.`
      );
      return 'failed';
    }
    return 'unchanged';
  }

  // Rewrite only the recipients assignment so user-authored comments and formatting survive.
  // Re-parse before writing: an unusual layout (e.g. dotted keys) could make the textual edit
  // produce a duplicate table or leave the old recipients in effect.
  const updatedContent = replaceAgeRecipients(originalContent);
  const updatedProvider = (parse(updatedContent) as FnoxToml).providers?.age;
  const updatedRecipients = Array.isArray(updatedProvider?.recipients) ? updatedProvider.recipients : [];
  if (
    updatedRecipients.length !== FNOX_AGE_RECIPIENTS.length ||
    !FNOX_AGE_RECIPIENTS.every((recipient, index) => updatedRecipients[index] === recipient.publicKey)
  ) {
    throw new Error(`Rewriting the age recipients in ${fnoxTomlPath} did not take effect; update them manually.`);
  }
  await fsUtil.generateFile(fnoxTomlPath, updatedContent);

  if (!reencryptFnoxSecrets(dirPath, profileNames)) {
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

// Re-encrypts the base secrets and each profile's own secrets (--no-defaults keeps the merged
// base secrets from being duplicated into profile tables) for the current recipient set. The
// spawned fnox runs with an isolated HOME/XDG_CONFIG_HOME because fnox merges the user-global
// ~/.config/fnox/config.toml into every project config — a plain reencrypt would rewrite the
// user's global secrets too. Decryption therefore needs the personal identity passed explicitly
// via FNOX_AGE_KEY; FNOX_PROFILE is stripped so it cannot redirect the base (no -P) run.
function reencryptFnoxSecrets(dirPath: string, profileNames: string[]): boolean {
  // The identity is optional: a plaintext-only config has nothing to decrypt and fnox succeeds
  // without one, while existing ciphertexts make fnox fail loudly on its own.
  const identity = readPersonalAgeSecretKey() ?? process.env.FNOX_AGE_KEY;
  const isolatedHomeDirPath = fs.mkdtempSync(path.join(os.tmpdir(), 'wbfy-fnox-home-'));
  try {
    return withFnoxLocalHidden(dirPath, () => {
      const env = {
        ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('FNOX_'))),
        ...(identity ? { FNOX_AGE_KEY: identity } : {}),
        HOME: isolatedHomeDirPath,
        XDG_CONFIG_HOME: isolatedHomeDirPath,
      };
      const profileArgsList = [[], ...profileNames.map((name) => ['--no-defaults', '-P', name])];
      for (const profileArgs of profileArgsList) {
        const args = ['reencrypt', '--force', '--no-daemon', '--provider', 'age', ...profileArgs];
        console.log(`$ fnox ${args.join(' ')} at ${dirPath}`);
        const proc = child_process.spawnSync('fnox', args, { cwd: dirPath, encoding: 'utf8', stdio: 'inherit', env });
        if ((proc.status ?? 1) !== 0) return false;
      }
      return true;
    });
  } finally {
    fs.rmSync(isolatedHomeDirPath, { recursive: true, force: true });
  }
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
 * Restores a fnox.local.toml backup left by an interrupted earlier run so the user's local
 * overrides are never silently lost. Returns whether a stale backup was recovered.
 */
function recoverStaleFnoxLocalBackup(dirPath: string): boolean {
  const localPath = path.resolve(dirPath, 'fnox.local.toml');
  const hiddenPath = `${localPath}.wbfy-bak`;
  if (!fs.existsSync(hiddenPath)) return false;
  if (fs.existsSync(localPath)) {
    throw new Error(`Both ${localPath} and ${hiddenPath} exist; resolve the leftover backup manually.`);
  }
  fs.renameSync(hiddenPath, localPath);
  return true;
}

/**
 * Runs a function while the machine-local fnox.local.toml is temporarily moved aside: fnox loads
 * it at higher priority than the committed fnox.toml, so a local override shadowing a committed
 * secret would make `fnox reencrypt` skip that secret.
 */
function withFnoxLocalHidden<T>(dirPath: string, func: () => T): T {
  recoverStaleFnoxLocalBackup(dirPath);
  const localPath = path.resolve(dirPath, 'fnox.local.toml');
  const hiddenPath = `${localPath}.wbfy-bak`;
  const exists = fs.existsSync(localPath);
  if (exists) fs.renameSync(localPath, hiddenPath);
  try {
    return func();
  } finally {
    if (exists) fs.renameSync(hiddenPath, localPath);
  }
}

function replaceAgeRecipients(content: string): string {
  const recipientsText = `recipients = [${FNOX_AGE_RECIPIENTS.map((recipient) => `"${recipient.publicKey}"`).join(', ')}]`;
  // Standard form: a [providers.age] table (possibly with a trailing comment). Scan line-wise so
  // that a `[` inside a comment or a string never terminates the table early; the table ends at
  // the next line-start table header. The assignment match is line-anchored so a commented-out
  // `# recipients = [...]` is never mistaken for the real one.
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
