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

/**
 * Synchronizes the age recipients in fnox.toml with FNOX_AGE_RECIPIENTS and re-encrypts the
 * committed secrets when the recipient set changed.
 */
export async function generateFnoxToml(config: PackageConfig): Promise<void> {
  return logger.functionIgnoringException('generateFnoxToml', async () => {
    // A failed synchronization must fail the whole wbfy run: exiting zero with stale recipients
    // would leave secrets undecryptable for new recipients while looking successful.
    try {
      await synchronizeFnoxAgeRecipients(config);
    } catch (error) {
      console.error('Failed to synchronize fnox age recipients due to:', (error as Error | undefined)?.stack ?? error);
      process.exitCode = 1;
    }
  });
}

async function synchronizeFnoxAgeRecipients(config: PackageConfig): Promise<void> {
  const dirPath = config.dirPath;
  const fnoxTomlPath = path.resolve(dirPath, 'fnox.toml');
  if (!fs.existsSync(fnoxTomlPath)) return;

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
    console.error(
      `Failed to synchronize fnox age recipients in ${dirPath} because per-profile config files are not supported: ${profileConfigFileNames.join(', ')}. Merge them into fnox.toml.`
    );
    process.exitCode = 1;
    return;
  }
  const localTomlPath = path.resolve(dirPath, 'fnox.local.toml');
  if (fs.existsSync(localTomlPath)) {
    const localSettings = parse(fs.readFileSync(localTomlPath, 'utf8')) as FnoxToml;
    const definesProviders =
      localSettings.import ??
      localSettings.providers ??
      Object.values(localSettings.profiles ?? {}).find((profile) => profile?.providers);
    if (definesProviders) {
      console.error(
        `Failed to synchronize fnox age recipients in ${dirPath} because fnox.local.toml defines imports, providers, or profile providers, which this generator cannot keep in sync. Keep only machine-local secret overrides there.`
      );
      process.exitCode = 1;
      return;
    }
  }

  // A parse failure must abort instead of falling back to {}: regenerating from an empty object
  // would silently drop the committed encrypted secrets.
  const originalContent = fs.readFileSync(fnoxTomlPath, 'utf8');
  const settings = parse(originalContent) as FnoxToml;
  if (settings.import) {
    console.error(
      `Failed to synchronize fnox age recipients in ${dirPath} because \`import\` is not supported. Merge the imported files into fnox.toml.`
    );
    process.exitCode = 1;
    return;
  }
  const profilesWithProviders = Object.entries(settings.profiles ?? {})
    .filter(([, profile]) => profile?.providers)
    .map(([name]) => name);
  if (profilesWithProviders.length > 0) {
    console.error(
      `Failed to synchronize fnox age recipients in ${dirPath} because profile-specific providers are not supported: ${profilesWithProviders.join(', ')}. Move them to the top-level [providers] table.`
    );
    process.exitCode = 1;
    return;
  }

  // A workspace package's fnox.toml without its own age provider inherits the root one through
  // fnox's hierarchical loading, so only the root config must declare the provider.
  if (!config.isRoot && !settings.providers?.age) return;

  const ageProvider = settings.providers?.age ?? {};
  const currentRecipients = new Set(Array.isArray(ageProvider.recipients) ? ageProvider.recipients : []);
  if (
    currentRecipients.size === FNOX_AGE_RECIPIENTS.length &&
    FNOX_AGE_RECIPIENTS.every((recipient) => currentRecipients.has(recipient.publicKey))
  ) {
    return;
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

  // Re-encrypt the base secrets and each profile's own secrets (--no-defaults keeps the merged
  // base secrets from being duplicated into profile tables) for the new recipient set. This
  // requires an identity that can decrypt the current ciphertexts (e.g. ~/.config/fnox/age.txt).
  const profileArgs = [[], ...Object.keys(settings.profiles ?? {}).map((name) => ['--no-defaults', '-P', name])];
  for (const args of profileArgs) {
    const status = spawnSyncAndReturnStatus(
      'fnox',
      ['reencrypt', '--force', '--no-daemon', '--provider', 'age', ...args],
      dirPath
    );
    if (status !== 0) {
      // Restore the original config: keeping the new recipients with old ciphertexts would make
      // this generator skip re-encryption forever and let setupSecrets upload a CI key that
      // cannot decrypt anything. The old ciphertexts remain valid for the old recipients.
      await fsUtil.generateFile(fnoxTomlPath, originalContent);
      console.error('Failed to re-encrypt fnox secrets for the updated recipients. Fix the error and rerun wbfy.');
      process.exitCode = 1;
      return;
    }
  }
}

function replaceAgeRecipients(content: string): string {
  const recipientsText = `recipients = [${FNOX_AGE_RECIPIENTS.map((recipient) => `"${recipient.publicKey}"`).join(', ')}]`;
  // Replace the recipients assignment inside the [providers.age] table; [^[] keeps the lazy match
  // from crossing into the next table header.
  const withReplacedRecipients = content.replace(
    /(\[providers\.age\][^[]*?)recipients\s*=\s*\[[^\]]*\]/u,
    `$1${recipientsText}`
  );
  if (withReplacedRecipients !== content) return withReplacedRecipients;
  const withInsertedRecipients = content.replace(
    /\[providers\.age\]([^\n]*\n)/u,
    `[providers.age]$1${recipientsText}\n`
  );
  if (withInsertedRecipients !== content) return withInsertedRecipients;
  return `${content.trimEnd()}\n\n[providers.age]\ntype = "age"\n${recipientsText}\n`;
}
