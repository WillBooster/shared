import fs from 'node:fs';
import path from 'node:path';

import { readEnvironmentVariables } from '@willbooster/shared-lib-node/src';
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
  try {
    const envExamplePath = project.findFile('.env.example');
    return [...fs.readFileSync(envExamplePath, 'utf8').matchAll(/^([A-Z_0-9]+)=/gmu)].map(
      (match) => match[1] as string
    );
  } catch {
    return [];
  }
}

/**
 * Quote a value for dotenv (which wrangler uses for .dev.vars). Single-quoted values are
 * preserved literally — round-tripping newlines, quotes, backslashes, and literal \n sequences
 * (verified against wrangler's bundled dotenv 16) — except that a single quote right before a
 * newline closes the quoted span early; such values fall back to backticks (also literal in
 * dotenv 16), then to double quotes with escaped newlines (which dotenv unescapes, so values
 * that also contain a double quote or a literal \n sequence cannot round-trip and are
 * rejected instead of being silently corrupted).
 */
export function quoteDotenvValue(key: string, value: string): string {
  if (!(value.includes("'") && value.includes('\n'))) return `'${value}'`;
  if (!value.includes('`')) return `\`${value}\``;
  if (!value.includes('"') && !value.includes(String.raw`\n`)) {
    return `"${value.replaceAll('\n', String.raw`\n`)}"`;
  }
  throw new Error(`The value of ${key} cannot be losslessly serialized into .dev.vars; simplify its quoting.`);
}
