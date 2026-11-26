import fs from 'node:fs';
import path from 'node:path';

import { writeFileAtomicSync } from '@willbooster/shared-lib-node/src';
import chalk from 'chalk';
import { parse as parseDotenv } from 'dotenv';
import type { ArgumentsCamelCase, Argv, CommandModule, InferredOptionTypes } from 'yargs';

import { findSelfProjectOrExit } from '../project.js';
import type { sharedOptionsBuilder } from '../sharedOptionsBuilder.js';
import { getChosenLocalStateDir } from '../utils/cloudflare.js';
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

    const content = lines.join('\n') + '\n';
    // Concurrent servers of one mode share the file, and a starting server must never read it
    // half-written, so an unchanged file stays untouched and a changed one is replaced atomically.
    const existingContent = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, 'utf8') : undefined;
    if (existingContent !== content) {
      // An isolated instance must not hand its values to another instance of the mode.
      if (existingContent !== undefined && getChosenLocalStateDir(project)) {
        throw new Error(
          `${outputPath} holds other values than this instance's, and instances on a chosen WB_CLOUDFLARE_STATE_DIR share it: give an instance its own value with \`--var <name>:<value>\` after \`--\`, or regenerate the file with \`wb gen-dev-vars\` without WB_CLOUDFLARE_STATE_DIR.`
        );
      }
      writeFileAtomicSync(outputPath, content);
    }
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
