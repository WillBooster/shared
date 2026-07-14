import fs from 'node:fs';
import path from 'node:path';

import { readEnvironmentVariables } from '@willbooster/shared-lib-node/src';
import { parse as parseDotenv } from 'dotenv';
import chalk from 'chalk';
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
    // the stale file value.
    for (const key of Object.keys(envVars)) {
      const effectiveValue = project.env[key];
      if (effectiveValue !== undefined) envVars[key] = effectiveValue;
    }
    // Supplement with process environment values for the keys named in .env.example: CI often
    // provides them as workflow env instead of .env files (still an allowlist, so unrelated
    // process environment variables cannot leak).
    for (const key of readEnvExampleKeys(project)) {
      envVars[key] ||= project.env[key] || '';
    }
    for (const key of ['WB_ENV', 'NEXT_PUBLIC_WB_ENV']) {
      envVars[key] ||= project.env[key] || '';
    }

    const lines = Object.entries(envVars)
      .filter(([, value]) => value !== '')
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
 * Quote a value for dotenv (which wrangler uses for .dev.vars), choosing a representation that
 * round-trips under wrangler's bundled dotenv 16 parser or throwing:
 * - Values without an apostrophe use single quotes (the quoted span preserves newlines, `#`,
 *   double quotes, backticks, backslashes, and literal \n sequences).
 * - An apostrophe inside a single-quoted span closes it early (a trailing `#…` is then even
 *   parsed as a comment), so such values use backticks — equally literal in dotenv 16.
 * - With both an apostrophe and a backtick, double quotes work when the value contains no
 *   double quote and no literal \n sequence (dotenv unescapes \n in double-quoted values).
 * - Carriage returns never round-trip (the parser normalizes CRLF/CR to LF before parsing).
 */
export function quoteDotenvValue(key: string, value: string): string {
  if (value.includes('\r')) {
    throw new Error(`The value of ${key} contains a carriage return, which .dev.vars cannot represent.`);
  }
  if (!value.includes("'")) return `'${value}'`;
  if (!value.includes('`')) return `\`${value}\``;
  if (!value.includes('"') && !value.includes(String.raw`\n`)) {
    return `"${value.replaceAll('\n', String.raw`\n`)}"`;
  }
  throw new Error(`The value of ${key} cannot be losslessly serialized into .dev.vars; simplify its quoting.`);
}
