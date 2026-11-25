import fs from 'node:fs';
import path from 'node:path';

import chalk from 'chalk';
import { parse as parseDotenv } from 'dotenv';
import type { ArgumentsCamelCase, Argv, CommandModule, InferredOptionTypes } from 'yargs';

import { findSelfProjectOrExit } from '../project.js';
import type { sharedOptionsBuilder } from '../sharedOptionsBuilder.js';
import { resolveCloudflareMode, resolveLocalCloudflareConfig } from '../utils/cloudflareConfig.js';
import { resolveDeclaredSecrets } from '../utils/workerSecrets.js';

// Cloudflare Workers don't see the process environment; a locally served Worker reads the values
// of its declared secrets from a .dev.vars file next to its config file instead. This command
// bridges the fnox-managed values to that file.
const builder = {} as const;

type GenDevVarsCommandOptions = InferredOptionTypes<typeof builder & typeof sharedOptionsBuilder>;
type GenDevVarsCommandArgv = ArgumentsCamelCase<GenDevVarsCommandOptions & { path?: string }>;

export const genDevVarsCommand: CommandModule<unknown, GenDevVarsCommandOptions> = {
  command: 'gen-dev-vars [path]',
  describe:
    'Generate a .dev.vars file for a locally served Worker: the secrets cloudflare.config.ts declares with bindings.secret(), with their values from fnox or the environment.',
  builder: (yargs) =>
    yargs.positional('path', {
      description:
        'Output path of the generated file (default: .dev.vars.<mode>, which the local runtime reads for that mode).',
      type: 'string',
    }) as unknown as Argv<GenDevVarsCommandOptions>,
  async handler(argv: GenDevVarsCommandArgv) {
    const project = findSelfProjectOrExit(argv);

    // Exactly the secrets `wb deploy` would push for this mode: a locally served Worker reads
    // nothing else from the file, and a secret without a value stays unset.
    const mode = resolveCloudflareMode(project);
    const secretNames = resolveLocalCloudflareConfig(project, mode)?.secretNames ?? [];
    const { secrets } = resolveDeclaredSecrets(argv, project, secretNames);
    const lines = Object.entries(secrets)
      .toSorted(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => `${key}=${quoteDotenvValue(key, value)}`);
    const outputPath = path.resolve(project.dirPath, argv.path ?? `.dev.vars.${mode}`);
    if (argv.dryRun) {
      console.info(chalk.cyan(`Would generate ${outputPath} with ${lines.length} declared secrets.`));
      return;
    }

    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, lines.join('\n') + '\n');
    console.info(chalk.green(`Generated ${outputPath} with ${lines.length} declared secrets.`));
  },
};

/**
 * Quote a value for dotenv (the format of .dev.vars). Every candidate representation
 * is verified by actually parsing it back (our dotenv parser matches the local Worker runtime's
 * for these constructs), so a value is either serialized losslessly or rejected — never
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
