import fs from 'node:fs';
import path from 'node:path';

import { parse } from 'smol-toml';

import { logger } from '../logger.js';
import type { PackageConfig } from '../packageConfig.js';
import { fsUtil } from '../utils/fsUtil.js';
import { spawnSyncAndReturnStatus } from '../utils/spawnUtil.js';

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

const IGNORED_DIRECTORY_NAMES = new Set(['node_modules', 'dist', 'build', 'out', 'coverage', 'test_fixtures']);

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
 * Lists every directory in the repository containing a fnox.toml (excluding dependency and build
 * output directories): fnox loads configs hierarchically, so any of them can govern secrets.
 */
export function listFnoxTomlDirPaths(rootDirPath: string): string[] {
  const dirPaths: string[] = [];
  const walk = (dirPath: string): void => {
    if (fs.existsSync(path.join(dirPath, 'fnox.toml'))) dirPaths.push(dirPath);
    for (const dirent of fs.readdirSync(dirPath, { withFileTypes: true })) {
      if (!dirent.isDirectory() || dirent.name.startsWith('.') || IGNORED_DIRECTORY_NAMES.has(dirent.name)) continue;
      walk(path.join(dirPath, dirent.name));
    }
  };
  walk(rootDirPath);
  return dirPaths;
}

/** Reads the profile names declared in a fnox.toml (empty when the file is absent). */
export function readFnoxProfileNames(dirPath: string): string[] {
  const fnoxTomlPath = path.resolve(dirPath, 'fnox.toml');
  if (!fs.existsSync(fnoxTomlPath)) return [];
  const settings = parse(fs.readFileSync(fnoxTomlPath, 'utf8')) as FnoxToml;
  return Object.keys(settings.profiles ?? {});
}

/**
 * Runs a function while the machine-local fnox.local.toml is temporarily moved aside: fnox loads
 * it at higher priority than the committed fnox.toml, so a local override shadowing a committed
 * secret would make `fnox reencrypt` skip that secret. A stale backup from an interrupted earlier
 * run is restored first so the user's local overrides are never silently lost.
 */
function withFnoxLocalHidden<T>(dirPath: string, func: () => T): T {
  const localPath = path.resolve(dirPath, 'fnox.local.toml');
  const hiddenPath = `${localPath}.wbfy-bak`;
  if (fs.existsSync(hiddenPath)) {
    if (fs.existsSync(localPath)) {
      throw new Error(`Both ${localPath} and ${hiddenPath} exist; resolve the leftover backup manually.`);
    }
    fs.renameSync(hiddenPath, localPath);
  }
  const exists = fs.existsSync(localPath);
  if (exists) fs.renameSync(localPath, hiddenPath);
  try {
    return func();
  } finally {
    if (exists) fs.renameSync(hiddenPath, localPath);
  }
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
    // A failed synchronization must fail the whole wbfy run: exiting zero with stale recipients
    // would leave secrets undecryptable for new recipients while looking successful.
    try {
      const rootDirPath = rootConfig.dirPath;
      const rootTomlPath = path.resolve(rootDirPath, 'fnox.toml');
      if (!fs.existsSync(rootTomlPath)) return;
      const rootOriginalContent = fs.readFileSync(rootTomlPath, 'utf8');

      // The root goes first so that configs inheriting the root provider re-encrypt against the
      // already-updated recipients.
      const rootResult = await synchronizeFnoxAgeRecipients(rootDirPath, true, false);
      const rootChanged = rootResult === 'changed';
      let childFailed = false;
      for (const dirPath of listFnoxTomlDirPaths(rootDirPath)) {
        if (dirPath === rootDirPath) continue;
        childFailed ||= (await synchronizeFnoxAgeRecipients(dirPath, false, rootChanged)) === 'failed';
      }
      if (rootChanged && childFailed) {
        // Restore the root recipients so the next run redoes the whole migration including the
        // failed child; otherwise the unchanged root would skip the child's re-encryption forever.
        await fsUtil.generateFile(rootTomlPath, rootOriginalContent);
      }
    } catch (error) {
      failFnoxSync(`Failed to synchronize fnox age recipients due to: ${(error as Error | undefined)?.stack ?? error}`);
    }
  });
}

function failFnoxSync(message: string): void {
  console.error(message);
  process.exitCode = 1;
  fnoxSyncFailed = true;
}

async function synchronizeFnoxAgeRecipients(
  dirPath: string,
  isRoot: boolean,
  rootRecipientsChanged: boolean
): Promise<'changed' | 'unchanged' | 'failed'> {
  const fnoxTomlPath = path.resolve(dirPath, 'fnox.toml');

  // Recipient synchronization only understands the standard single-file layout with one
  // top-level age provider named `age`. Per-profile config files, imports, differently named age
  // providers, or provider overrides would keep using recipient sets this generator does not
  // rewrite, so their secrets would silently stay undecryptable for new recipients; fail instead
  // of proceeding. The gitignored fnox.local.toml is a supported machine-local override, but only
  // while it leaves providers alone.
  const profileConfigFileNames = fs
    .readdirSync(dirPath)
    .filter((name) => /^fnox\..+\.toml$/u.test(name) && name !== 'fnox.local.toml')
    .toSorted();
  if (profileConfigFileNames.length > 0) {
    failFnoxSync(
      `Failed to synchronize fnox age recipients in ${dirPath} because per-profile config files are not supported: ${profileConfigFileNames.join(', ')}. Merge them into fnox.toml.`
    );
    return 'failed';
  }
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

  // A nested fnox.toml without its own age provider inherits the root one through fnox's
  // hierarchical loading, so only the root config must declare the provider — but the nested
  // config's own ciphertexts still must be re-encrypted whenever the root recipients changed,
  // and that only happens when `fnox reencrypt` runs from the nested directory.
  if (!isRoot && !settings.providers?.age) {
    if (rootRecipientsChanged && !reencryptFnoxSecrets(dirPath, profileNames)) {
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
// base secrets from being duplicated into profile tables) for the current recipient set. This
// requires an identity that can decrypt the current ciphertexts (e.g. ~/.config/fnox/age.txt).
function reencryptFnoxSecrets(dirPath: string, profileNames: string[]): boolean {
  return withFnoxLocalHidden(dirPath, () => {
    // An ambient FNOX_PROFILE would silently redirect the base (no -P) run to a profile.
    delete process.env.FNOX_PROFILE;
    const profileArgs = [[], ...profileNames.map((name) => ['--no-defaults', '-P', name])];
    for (const args of profileArgs) {
      const status = spawnSyncAndReturnStatus(
        'fnox',
        ['reencrypt', '--force', '--no-daemon', '--provider', 'age', ...args],
        dirPath
      );
      if (status !== 0) return false;
    }
    return true;
  });
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
