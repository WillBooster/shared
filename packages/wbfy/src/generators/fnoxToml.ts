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

interface FnoxToml {
  import?: unknown;
  providers?: Record<string, Record<string, unknown> | undefined>;
  profiles?: Record<string, Record<string, unknown> | undefined>;
  [key: string]: unknown;
}

let fnoxSyncFailed = false;

/** Whether any fnox recipient synchronization failed; setupSecrets must not upload then. */
export function hasFnoxSyncFailed(): boolean {
  return fnoxSyncFailed;
}

/**
 * Runs a function while the machine-local fnox.local.toml is temporarily moved aside: fnox loads
 * it at higher priority than the committed fnox.toml, so a local override shadowing a committed
 * secret would make `fnox reencrypt` skip that secret and `fnox export` report the local value.
 */
export function withFnoxLocalHidden<T>(dirPath: string, func: () => T): T {
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

/**
 * Synchronizes the age recipients in every fnox.toml with FNOX_AGE_RECIPIENTS and re-encrypts the
 * committed secrets when the recipient set changed.
 */
export async function generateFnoxToml(rootConfig: PackageConfig, allConfigs: PackageConfig[]): Promise<void> {
  return logger.functionIgnoringException('generateFnoxToml', async () => {
    // A failed synchronization must fail the whole wbfy run: exiting zero with stale recipients
    // would leave secrets undecryptable for new recipients while looking successful.
    try {
      // The root goes first so that package configs inheriting the root provider re-encrypt
      // against the already-updated recipients.
      const rootChanged = await synchronizeFnoxAgeRecipients(rootConfig, false);
      for (const config of allConfigs.filter((config) => !config.isRoot)) {
        await synchronizeFnoxAgeRecipients(config, rootChanged);
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

async function synchronizeFnoxAgeRecipients(config: PackageConfig, rootRecipientsChanged: boolean): Promise<boolean> {
  const dirPath = config.dirPath;
  const fnoxTomlPath = path.resolve(dirPath, 'fnox.toml');
  if (!fs.existsSync(fnoxTomlPath)) return false;

  // Recipient synchronization only understands the standard single-file layout with one
  // top-level age provider. Per-profile config files, imports, or provider overrides would keep
  // using recipient sets this generator does not rewrite, so their secrets would silently stay
  // undecryptable for new recipients; fail instead of proceeding. The gitignored fnox.local.toml
  // is a supported machine-local override, but only while it leaves providers alone.
  const profileConfigFileNames = fs
    .readdirSync(dirPath)
    .filter((name) => /^fnox\..+\.toml$/u.test(name) && name !== 'fnox.local.toml')
    .toSorted();
  if (profileConfigFileNames.length > 0) {
    failFnoxSync(
      `Failed to synchronize fnox age recipients in ${dirPath} because per-profile config files are not supported: ${profileConfigFileNames.join(', ')}. Merge them into fnox.toml.`
    );
    return false;
  }
  const localTomlPath = path.resolve(dirPath, 'fnox.local.toml');
  if (fs.existsSync(localTomlPath)) {
    const localSettings = parse(fs.readFileSync(localTomlPath, 'utf8')) as FnoxToml;
    const definesProviders =
      localSettings.import ??
      localSettings.providers ??
      Object.values(localSettings.profiles ?? {}).find((profile) => profile?.providers);
    if (definesProviders) {
      failFnoxSync(
        `Failed to synchronize fnox age recipients in ${dirPath} because fnox.local.toml defines imports, providers, or profile providers, which this generator cannot keep in sync. Keep only machine-local secret overrides there.`
      );
      return false;
    }
  }

  // A parse failure must abort instead of falling back to {}: regenerating from an empty object
  // would silently drop the committed encrypted secrets.
  const originalContent = fs.readFileSync(fnoxTomlPath, 'utf8');
  const settings = parse(originalContent) as FnoxToml;
  if (settings.import) {
    failFnoxSync(
      `Failed to synchronize fnox age recipients in ${dirPath} because \`import\` is not supported. Merge the imported files into fnox.toml.`
    );
    return false;
  }
  const profilesWithProviders = Object.entries(settings.profiles ?? {})
    .filter(([, profile]) => profile?.providers)
    .map(([name]) => name);
  if (profilesWithProviders.length > 0) {
    failFnoxSync(
      `Failed to synchronize fnox age recipients in ${dirPath} because profile-specific providers are not supported: ${profilesWithProviders.join(', ')}. Move them to the top-level [providers] table.`
    );
    return false;
  }

  const profileNames = Object.keys(settings.profiles ?? {});

  // A workspace package's fnox.toml without its own age provider inherits the root one through
  // fnox's hierarchical loading, so only the root config must declare the provider — but the
  // package's own ciphertexts still must be re-encrypted whenever the root recipients changed,
  // and that only happens when `fnox reencrypt` runs from the package directory.
  if (!config.isRoot && !settings.providers?.age) {
    if (rootRecipientsChanged && !reencryptFnoxSecrets(dirPath, profileNames)) {
      failFnoxSync(
        `Failed to re-encrypt fnox secrets in ${dirPath} for the updated recipients. Fix the error and rerun wbfy.`
      );
    }
    return false;
  }

  const ageProvider = settings.providers?.age ?? {};
  const currentRecipients = new Set(Array.isArray(ageProvider.recipients) ? ageProvider.recipients : []);
  if (
    currentRecipients.size === FNOX_AGE_RECIPIENTS.length &&
    FNOX_AGE_RECIPIENTS.every((recipient) => currentRecipients.has(recipient.publicKey))
  ) {
    return false;
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
    return false;
  }
  return true;
}

// Re-encrypts the base secrets and each profile's own secrets (--no-defaults keeps the merged
// base secrets from being duplicated into profile tables) for the current recipient set. This
// requires an identity that can decrypt the current ciphertexts (e.g. ~/.config/fnox/age.txt).
function reencryptFnoxSecrets(dirPath: string, profileNames: string[]): boolean {
  return withFnoxLocalHidden(dirPath, () => {
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
  // Standard form: a [providers.age] table. Scan line-wise so that a `[` inside a comment or a
  // string never terminates the table early; the table ends at the next line-start table header.
  const lines = content.split('\n');
  const headerIndex = lines.findIndex((line) => line.trim() === '[providers.age]');
  if (headerIndex !== -1) {
    let endIndex = lines.length;
    for (let index = headerIndex + 1; index < lines.length; index++) {
      if (/^\s*\[/u.test(lines[index] ?? '')) {
        endIndex = index;
        break;
      }
    }
    const section = lines.slice(headerIndex, endIndex).join('\n');
    const replacedSection = section.replace(/recipients\s*=\s*\[[^\]]*\]/u, recipientsText);
    const newSection =
      replacedSection === section
        ? section.replace('[providers.age]', `[providers.age]\n${recipientsText}`)
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
