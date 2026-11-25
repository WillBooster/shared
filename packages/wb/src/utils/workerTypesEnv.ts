import fs from 'node:fs';
import path from 'node:path';

import chalk from 'chalk';

import type { FnoxSecretsTable } from './fnoxToml.js';
import { findAncestorFnoxConfigPaths, parseFnoxConfig } from './fnoxToml.js';

/**
 * Write the key-only stub that `wrangler types --env-file` reads to type the Cloudflare `Env`.
 *
 * `wrangler types` derives each `Env` member from a key's mere presence in the file — never from its
 * value, and never from process.env — and `--env-file` REPLACES wrangler's native `.env`/`.dev.vars`
 * reading. The stub therefore carries every declared binding key with a constant placeholder value
 * (`1`, not empty, so it cannot override a wrangler `vars` binding with an empty string). It writes no
 * real secret and needs no decryption.
 */
export function writeWorkerTypesEnvStub(projectDirPath: string, rootDirPath: string, outputPath: string): void {
  const keyNames = collectWorkerBindingKeyNames(projectDirPath, rootDirPath);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(
    outputPath,
    keyNames.map((keyName) => `${keyName}=1`).join('\n') + (keyNames.length > 0 ? '\n' : '')
  );
  console.info(chalk.green(`Generated ${outputPath} with ${keyNames.length} environment variable names.`));
}

/**
 * Collect the declared Worker binding key NAMES from the committed `fnox.toml` files without
 * decrypting anything or invoking the environment reader. This deliberately avoids process.env,
 * `mise env` host/tool variables, and cascade/profile selection, all of which would otherwise
 * pollute or narrow the generated `Env`.
 */
export function collectWorkerBindingKeyNames(projectDirPath: string, rootDirPath: string): string[] {
  const keyNames = new Set<string>();
  // fnox merges the whole ancestor config chain (a nested Worker inherits the monorepo root's
  // secrets), so union every fnox.toml from the project directory up to the repository root.
  for (const configPath of findAncestorFnoxConfigPaths(projectDirPath, rootDirPath)) {
    for (const keyName of parseFnoxSecretKeyNames(configPath)) keyNames.add(keyName);
  }
  return [...keyNames].toSorted((a, b) => a.localeCompare(b));
}

/**
 * Parse the key names under `fnox.toml`'s `[secrets]` and every `[profiles.<name>.secrets]` table.
 * fnox stores key names in plaintext (only values are encrypted), so this needs no age key. Every
 * profile's secrets are unioned so the Env is a deterministic superset covering all environments
 * (like the former committed .env.example), independent of the profile a given run resolves.
 */
function parseFnoxSecretKeyNames(configPath: string): string[] {
  const config = parseFnoxConfig(configPath);
  const keyNames: string[] = [];
  const collect = (secrets: FnoxSecretsTable | undefined): void => {
    for (const [keyName, entry] of Object.entries(secrets ?? {})) {
      // Skip secrets fnox does not export as environment variables (`env = false` / `"exec"`): they
      // are never Worker bindings, matching `fnox export`'s default.
      const env = typeof entry === 'object' && entry !== null ? (entry as { env?: unknown }).env : undefined;
      if (env === false || env === 'exec') continue;
      keyNames.push(keyName);
    }
  };
  collect(config.secrets);
  for (const profile of Object.values(config.profiles ?? {})) collect(profile?.secrets);
  return keyNames;
}
