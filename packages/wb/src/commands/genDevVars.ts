import fs from 'node:fs';
import path from 'node:path';

import { readEnvironmentVariables } from '@willbooster/shared-lib-node/src';
import chalk from 'chalk';
import { parse as parseDotenv } from 'dotenv';
import type { ArgumentsCamelCase, Argv, CommandModule, InferredOptionTypes } from 'yargs';

import type { Project } from '../project.js';
import { findSelfProject } from '../project.js';
import type { sharedOptionsBuilder } from '../sharedOptionsBuilder.js';

// Cloudflare Workers don't see the process environment; wrangler dev reads vars from a .dev.vars
// file next to its config file instead. This command bridges wb-managed .env files to that file.
const builder = {} as const;

type GenDevVarsCommandOptions = InferredOptionTypes<typeof builder & typeof sharedOptionsBuilder>;
type GenDevVarsCommandArgv = ArgumentsCamelCase<GenDevVarsCommandOptions & { path?: string }>;

export const genDevVarsCommand: CommandModule<unknown, GenDevVarsCommandOptions> = {
  command: 'gen-dev-vars [path]',
  describe:
    'Generate a .dev.vars file for `wrangler dev` from the environment variables loaded from .env files (plus WB_ENV and NEXT_PUBLIC_WB_ENV).',
  builder: (yargs) =>
    yargs.positional('path', {
      description: 'Output path of the generated .dev.vars file.',
      type: 'string',
      default: '.dev.vars',
    }) as unknown as Argv<GenDevVarsCommandOptions>,
  async handler(argv: GenDevVarsCommandArgv) {
    const project = findSelfProject(argv);
    if (!project) {
      console.error(chalk.red('No project found.'));
      process.exit(1);
    }

    // Restrict to the variables loaded from .env files (wb's environment contract) so that
    // unrelated process environment variables never leak into the generated file. Ignore
    // process.env because the parent wb process injects the .env values into it, which would
    // otherwise suppress loading them here.
    const [envVars] = readEnvironmentVariables(argv, project.dirPath, { ignoreProcessEnv: true });
    // Explicitly exported environment variables must win over dotenv values for file-defined
    // keys (project.env applies that precedence), or `AUTH_SECRET=... wb start` would serve
    // the stale file value. An export that empties a non-empty file value is deliberate and
    // must survive the empty-value filter below (unlike `KEY=` placeholders in .env files,
    // which stay omitted so they cannot override wrangler `vars` with empty strings).
    const explicitlyEmptiedKeys = new Set<string>();
    for (const key of Object.keys(envVars)) {
      const effectiveValue = project.env[key];
      if (effectiveValue === undefined) continue;
      if (effectiveValue === '' && envVars[key] !== '') explicitlyEmptiedKeys.add(key);
      envVars[key] = effectiveValue;
    }
    // Supplement with process environment values for the keys named in .env.example: CI often
    // provides them as workflow env instead of .env files (still an allowlist, so unrelated
    // process environment variables cannot leak).
    for (const key of [...readEnvExampleKeys(project), 'WB_ENV', 'NEXT_PUBLIC_WB_ENV']) {
      const effectiveValue = project.env[key];
      if (envVars[key] || effectiveValue === undefined) continue;
      if (envVars[key] === undefined && effectiveValue === '') explicitlyEmptiedKeys.add(key);
      envVars[key] = effectiveValue;
    }

    const lines = Object.entries(envVars)
      .filter(([key, value]) => value !== '' || explicitlyEmptiedKeys.has(key))
      .toSorted(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => `${key}=${quoteDotenvValue(key, value)}`);
    const outputPath = path.resolve(project.dirPath, argv.path ?? '.dev.vars');
    if (argv.dryRun) {
      console.info(chalk.cyan(`Would generate ${outputPath} with ${lines.length} environment variables.`));
      return;
    }

    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, lines.join('\n') + '\n');
    console.info(chalk.green(`Generated ${outputPath} with ${lines.length} environment variables.`));
  },
};

export function readEnvExampleKeys(project: Project): string[] {
  let envExamplePath: string;
  try {
    envExamplePath = project.findFile('.env.example');
  } catch {
    return [];
  }
  // dotenv's own parser covers `export KEY=` prefixes and whitespace around `=`,
  // which a line regex would silently miss.
  return Object.keys(parseDotenv(fs.readFileSync(envExamplePath, 'utf8')));
}

/**
 * Quote a value for dotenv (which wrangler uses for .dev.vars). Every candidate representation
 * is verified by actually parsing it back (our dotenv parser matches wrangler's bundled dotenv
 * 16 for these constructs), so a value is either serialized losslessly or rejected — never
 * silently corrupted. Candidates: single quotes (literal span; closed early by an apostrophe),
 * backticks (equally literal), then double quotes with escaped newlines/CRs (dotenv does not
 * unescape inner \" — a `#` after an embedded quote starts a comment, which the round-trip
 * check catches and rejects).
 */
export function quoteDotenvValue(key: string, value: string): string {
  const doubleQuotedBody = value.replaceAll('\n', String.raw`\n`).replaceAll('\r', String.raw`\r`);
  const candidates = [`'${value}'`, `\`${value}\``, `"${doubleQuotedBody}"`];
  for (const candidate of candidates) {
    if (parseDotenv(`${key}=${candidate}`)[key] === value) return candidate;
  }
  throw new Error(`The value of ${key} cannot be losslessly serialized into .dev.vars; simplify its quoting.`);
}
