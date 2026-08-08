import fs from 'node:fs';
import path from 'node:path';

import { parse as parseToml } from 'smol-toml';

export interface FnoxSecretsTable {
  [keyName: string]: unknown;
}
export interface FnoxConfig {
  secrets?: FnoxSecretsTable;
  profiles?: Record<string, { secrets?: FnoxSecretsTable } | undefined>;
}

/** Every `fnox.toml` from `projectDirPath` up to (and including) `rootDirPath`, nearest first. */
export function findAncestorFnoxConfigPaths(projectDirPath: string, rootDirPath: string): string[] {
  const configPaths: string[] = [];
  const rootPath = path.resolve(rootDirPath);
  for (let dirPath = path.resolve(projectDirPath); ; dirPath = path.dirname(dirPath)) {
    const configPath = path.join(dirPath, 'fnox.toml');
    if (fs.existsSync(configPath)) configPaths.push(configPath);
    // Stop at the repository root (its parent's secrets are not part of this repo) or, defensively,
    // at the filesystem root when rootDirPath is not actually an ancestor.
    if (dirPath === rootPath || path.dirname(dirPath) === dirPath) break;
  }
  return configPaths;
}

export function parseFnoxConfig(configPath: string): FnoxConfig {
  return parseToml(fs.readFileSync(configPath, 'utf8')) as FnoxConfig;
}

/**
 * Resolve the values that are safe to bake into a Docker image: only entries whose EFFECTIVE
 * definition (base `[secrets]` overlaid by `[profiles.<profileName>.secrets]`, ancestor configs
 * overlaid by nearer ones — fnox's own precedence) is a plaintext `{ default = "..." }` without a
 * provider. Secrets never appear in the result, even when a plaintext base value is overridden by
 * an encrypted profile value (or vice versa: a profile plaintext override of an encrypted base IS
 * returned, because the effective entry is plaintext). Needs no age key and never decrypts.
 */
export function collectPlaintextFnoxValues(
  projectDirPath: string,
  rootDirPath: string,
  profileName: string | undefined
): Record<string, string> {
  // Null-prototype records: fnox accepts `__proto__` as an ordinary key, and Object.assign on a
  // default-prototype object would treat it as the legacy prototype setter and drop the entry.
  const effectiveEntries: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  // Root-most first so nearer configs overlay ancestor values; the profile table always overlays
  // the base table, matching fnox's profile resolution.
  const configs = findAncestorFnoxConfigPaths(projectDirPath, rootDirPath).toReversed().map(parseFnoxConfig);
  for (const config of configs) Object.assign(effectiveEntries, config.secrets);
  if (profileName) {
    for (const config of configs) Object.assign(effectiveEntries, config.profiles?.[profileName]?.secrets);
  }

  const values: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [keyName, entry] of Object.entries(effectiveEntries)) {
    if (typeof entry !== 'object' || entry === null) continue;
    const { default: defaultValue, env, provider } = entry as { default?: unknown; env?: unknown; provider?: unknown };
    // Skip entries fnox does not export as environment variables, matching `fnox export`'s default.
    if (env === false || env === 'exec') continue;
    if (provider === undefined && typeof defaultValue === 'string') values[keyName] = defaultValue;
  }
  return values;
}
