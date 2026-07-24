import fs from 'node:fs';
import path from 'node:path';

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
 * Collect the declared Worker binding key NAMES from committed sources — `fnox.toml` and any `.env*`
 * file — without decrypting anything or invoking the environment reader. This deliberately avoids
 * process.env, `mise env` host/tool variables, and cascade/profile selection, all of which would
 * otherwise pollute or narrow the generated `Env`.
 */
export function collectWorkerBindingKeyNames(projectDirPath: string, rootDirPath: string): string[] {
  const keyNames = new Set<string>();
  // fnox merges the whole ancestor config chain (a nested Worker inherits the monorepo root's
  // secrets), so union every fnox.toml from the project directory up to the repository root.
  for (const configPath of findAncestorFnoxConfigPaths(projectDirPath, rootDirPath)) {
    for (const keyName of parseFnoxSecretKeyNames(configPath)) keyNames.add(keyName);
  }
  // Union any committed `.env*` file wrangler would otherwise read natively (`--env-file` replaces
  // that reading). wb's env reader defaults include-root-env=true, so also scan the monorepo root,
  // deduped when it is the project directory. The gitignored, generated `.dev.vars*` runtime files
  // are not a committed source.
  for (const dirPath of new Set([path.resolve(projectDirPath), path.resolve(rootDirPath)])) {
    for (const keyName of collectEnvFileKeyNames(dirPath)) keyNames.add(keyName);
  }
  return [...keyNames].toSorted((a, b) => a.localeCompare(b));
}

/** Every `fnox.toml` from `projectDirPath` up to (and including) `rootDirPath`, nearest first. */
function findAncestorFnoxConfigPaths(projectDirPath: string, rootDirPath: string): string[] {
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

/** Key names declared in every `.env*` file directly under `dirPath` (values ignored). */
function collectEnvFileKeyNames(dirPath: string): string[] {
  const keyNames: string[] = [];
  let fileNames: string[];
  try {
    fileNames = fs.readdirSync(dirPath);
  } catch {
    return keyNames;
  }
  for (const fileName of fileNames) {
    if (!/^\.env(?:\.|$)/u.test(fileName)) continue;
    const filePath = path.join(dirPath, fileName);
    if (!fs.statSync(filePath).isFile()) continue;
    for (const keyName of Object.keys(parseDotenv(fs.readFileSync(filePath, 'utf8')))) keyNames.push(keyName);
  }
  return keyNames;
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
