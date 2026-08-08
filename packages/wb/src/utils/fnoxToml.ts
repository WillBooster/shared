import fs from 'node:fs';
import path from 'node:path';

import { parse as parseToml } from 'smol-toml';

export interface FnoxSecretsTable {
  [keyName: string]: unknown;
}
export interface FnoxConfig {
  root?: unknown;
  env?: unknown;
  default_provider?: unknown;
  import?: unknown;
  secrets?: FnoxSecretsTable;
  profiles?: Record<string, { secrets?: FnoxSecretsTable } | undefined>;
}

/**
 * Every `fnox.toml` from `projectDirPath` up to (and including) `rootDirPath`, nearest first.
 * A config declaring fnox's `root = true` chain boundary ends the walk, matching fnox itself.
 */
export function findAncestorFnoxConfigPaths(projectDirPath: string, rootDirPath: string): string[] {
  const configPaths: string[] = [];
  const rootPath = path.resolve(rootDirPath);
  for (let dirPath = path.resolve(projectDirPath); ; dirPath = path.dirname(dirPath)) {
    const configPath = path.join(dirPath, 'fnox.toml');
    if (fs.existsSync(configPath)) {
      configPaths.push(configPath);
      if (parseFnoxConfig(configPath).root === true) break;
    }
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
 *
 * Only the canonical wbfy fnox.toml layout is supported: fnox settings that would change what
 * `fnox export` yields relative to this static reading (a top-level `env` or `default_provider`,
 * `import`, or a value transformation such as `json_path`/`line`/`as_file`) fail fast instead of
 * silently baking values fnox would not export as-is.
 */
export function collectPlaintextFnoxValues(
  projectDirPath: string,
  rootDirPath: string,
  profileName: string | undefined
): Record<string, string> {
  // Root-most first so nearer configs overlay ancestor values; the profile table always overlays
  // the base table, matching fnox's profile resolution.
  const configPaths = findAncestorFnoxConfigPaths(projectDirPath, rootDirPath).toReversed();
  const configs = configPaths.map((configPath) => {
    const config = parseFnoxConfig(configPath);
    for (const settingName of ['default_provider', 'env', 'import'] as const) {
      if (config[settingName] !== undefined) {
        throw new Error(
          `${configPath} uses the top-level ${settingName} setting, which is outside the canonical wbfy fnox.toml layout; remove it or keep such values out of the Docker bake.`
        );
      }
    }
    return config;
  });
  // Null-prototype records: fnox accepts `__proto__` as an ordinary key, and Object.assign on a
  // default-prototype object would treat it as the legacy prototype setter and drop the entry.
  const effectiveEntries: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const config of configs) Object.assign(effectiveEntries, config.secrets);
  if (profileName) {
    for (const config of configs) Object.assign(effectiveEntries, config.profiles?.[profileName]?.secrets);
  }

  const values: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [keyName, entry] of Object.entries(effectiveEntries)) {
    if (typeof entry !== 'object' || entry === null) continue;
    const {
      as_file,
      default: defaultValue,
      env,
      json_path,
      line,
      provider,
      value,
    } = entry as {
      as_file?: unknown;
      default?: unknown;
      env?: unknown;
      json_path?: unknown;
      line?: unknown;
      provider?: unknown;
      value?: unknown;
    };
    // Skip entries fnox does not export as environment variables, matching `fnox export`'s default.
    if (env === false || env === 'exec') continue;
    // A `value` marks a provider-backed (encrypted) entry even in exotic configs; never bake it.
    if (provider !== undefined || value !== undefined) continue;
    if (typeof defaultValue !== 'string') continue;
    if (json_path !== undefined || line !== undefined || as_file !== undefined) {
      throw new Error(
        `The entry ${keyName} uses a fnox value transformation (json_path/line/as_file), so its exported value differs from its raw default; keep such values out of the Docker bake.`
      );
    }
    values[keyName] = defaultValue;
  }
  return values;
}
