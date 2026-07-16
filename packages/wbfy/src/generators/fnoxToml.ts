import fs from 'node:fs';
import path from 'node:path';

import { parse, stringify } from 'smol-toml';

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
  // exkazuu
  'age1j2354xhvm3fv9y77t5g6y3q8mexgk2mf00tgrkzgp73tynrvz55s8auayw',
  // CI
  'age1a2c6ef6ahl6mmkhgqtxg0mgtd7ysspntq7rxusv26efxhnuhlcdsr9dpak',
];

interface FnoxToml {
  providers?: Record<string, Record<string, unknown> | undefined>;
  profiles?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * Synchronizes the age recipients in fnox.toml with FNOX_AGE_RECIPIENTS and re-encrypts the
 * committed secrets when the recipient set changed.
 */
export async function generateFnoxToml(config: PackageConfig): Promise<void> {
  return logger.functionIgnoringException('generateFnoxToml', async () => {
    const fnoxTomlPath = path.resolve(config.dirPath, 'fnox.toml');
    if (!fs.existsSync(fnoxTomlPath)) return;

    // A parse failure must abort instead of falling back to {}: regenerating from an empty object
    // would silently drop the committed encrypted secrets.
    const settings = parse(fs.readFileSync(fnoxTomlPath, 'utf8')) as FnoxToml;
    const ageProvider = settings.providers?.age ?? {};
    const currentRecipients = Array.isArray(ageProvider.recipients) ? ageProvider.recipients : [];
    if (
      currentRecipients.length === FNOX_AGE_RECIPIENTS.length &&
      FNOX_AGE_RECIPIENTS.every((recipient, index) => currentRecipients[index] === recipient)
    ) {
      return;
    }

    settings.providers = {
      ...settings.providers,
      age: { ...ageProvider, type: 'age', recipients: [...FNOX_AGE_RECIPIENTS] },
    };
    await fsUtil.generateFile(fnoxTomlPath, stringify(settings));

    // Re-encrypt the base secrets and each profile's own secrets (--no-defaults keeps the merged
    // base secrets from being duplicated into profile tables) for the new recipient set. This
    // requires an identity that can decrypt the current ciphertexts (e.g. ~/.config/fnox/age.txt).
    const profileArgs = [[], ...Object.keys(settings.profiles ?? {}).map((name) => ['--no-defaults', '-P', name])];
    for (const args of profileArgs) {
      const status = spawnSyncAndReturnStatus('fnox', ['reencrypt', '--force', '--no-daemon', ...args], config.dirPath);
      if (status !== 0) {
        // Leaving the new recipients with old ciphertexts would let setupSecrets upload a CI key
        // that cannot decrypt anything, so fail the whole wbfy run loudly.
        console.error('Failed to re-encrypt fnox secrets for the updated recipients. Fix the error and rerun wbfy.');
        process.exitCode = 1;
        return;
      }
    }
  });
}
