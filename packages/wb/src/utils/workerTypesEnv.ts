import fs from 'node:fs';
import path from 'node:path';

import { findProjectFnoxConfigPath } from '@willbooster/shared-lib-node/src';
import chalk from 'chalk';
import { parse as parseDotenv } from 'dotenv';
import { parse as parseToml } from 'smol-toml';

/**
 * Write the key-only stub that `wrangler types --env-file` reads to type the Cloudflare `Env`.
 *
 * `wrangler types` derives each `Env` member from a key's mere presence in the file — never from its
 * value, and never from process.env — and `--env-file` REPLACES wrangler's native `.env`/`.dev.vars`
 * reading. The stub therefore carries every declared binding key with a constant placeholder value
 * (`1`, not empty, so it cannot override a wrangler `vars` binding with an empty string). It writes no
 * real secret and needs no decryption.
 */
export function writeWorkerTypesEnvStub(projectDirPath: string, outputPath: string): void {
  const keyNames = collectWorkerBindingKeyNames(projectDirPath);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(
    outputPath,
    keyNames.map((keyName) => `${keyName}=1`).join('\n') + (keyNames.length > 0 ? '\n' : '')
  );
  console.info(chalk.green(`Generated ${outputPath} with ${keyNames.length} environment variable names.`));
}

/**
 * Collect the declared Worker binding key NAMES from committed sources — `fnox.toml` (base and every
 * profile) and any `.env*` file — without decrypting anything or invoking the environment reader.
 * This deliberately avoids process.env, `mise env` host/tool variables, and cascade/profile
 * selection, all of which would otherwise pollute or narrow the generated `Env`.
 */
export function collectWorkerBindingKeyNames(projectDirPath: string): string[] {
  const keyNames = new Set<string>();
  const fnoxConfigPath = findProjectFnoxConfigPath(projectDirPath);
  if (fnoxConfigPath) {
    for (const keyName of parseFnoxSecretKeyNames(fnoxConfigPath)) keyNames.add(keyName);
  }
  // Union any committed `.env*` file wrangler would otherwise read natively (`--env-file` replaces
  // that reading). The gitignored, generated `.dev.vars*` runtime files are not a committed source.
  for (const fileName of fs.readdirSync(projectDirPath)) {
    if (!/^\.env(?:\.|$)/u.test(fileName)) continue;
    const filePath = path.join(projectDirPath, fileName);
    if (!fs.statSync(filePath).isFile()) continue;
    for (const keyName of Object.keys(parseDotenv(fs.readFileSync(filePath, 'utf8')))) keyNames.add(keyName);
  }
  return [...keyNames].toSorted((a, b) => a.localeCompare(b));
}

interface FnoxSecretsTable {
  [keyName: string]: unknown;
}
interface FnoxConfig {
  secrets?: FnoxSecretsTable;
  profiles?: Record<string, { secrets?: FnoxSecretsTable } | undefined>;
}

/**
 * Parse the key names under `fnox.toml`'s `[secrets]` and every `[profiles.<name>.secrets]` table.
 * fnox stores key names in plaintext (only values are encrypted), so this needs no age key. Every
 * profile's secrets are unioned so the Env is a deterministic superset covering all environments
 * (like the former committed .env.example), independent of the profile a given run resolves.
 */
function parseFnoxSecretKeyNames(configPath: string): string[] {
  const config = parseToml(fs.readFileSync(configPath, 'utf8')) as FnoxConfig;
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
