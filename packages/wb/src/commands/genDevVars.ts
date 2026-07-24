import fs from 'node:fs';
import path from 'node:path';

import { readEnvironmentVariables } from '@willbooster/shared-lib-node/src';
import chalk from 'chalk';
import { parse as parseDotenv } from 'dotenv';
import type { ArgumentsCamelCase, Argv, CommandModule, InferredOptionTypes } from 'yargs';

import { findSelfProject } from '../project.js';
import type { sharedOptionsBuilder } from '../sharedOptionsBuilder.js';

// Cloudflare Workers don't see the process environment; wrangler dev reads vars from a .dev.vars
// file next to its config file instead. This command bridges wb-managed .env files to that file.
const builder = {
  // `wrangler types` derives the Cloudflare `Env` members from the KEY NAMES in the .dev.vars/.env
  // files beside the wrangler config, never from their values. `--for-types` emits a stub for that
  // sole purpose: every declared key (including `KEY=` placeholders) with a constant placeholder
  // value. It never writes a real secret to disk, so it cannot leak one and cannot fail on a value
  // `quoteDotenvValue` refuses to serialize — and it is written to a throwaway path (not the real
  // .dev.vars) so `gen-code` can type a fresh checkout without clobbering the runtime file.
  'for-types': {
    description: 'Emit a key-only stub (placeholder values) for `wrangler types --env-file`, not a runtime .dev.vars.',
    type: 'boolean',
    default: false,
  },
} as const;

type GenDevVarsCommandOptions = InferredOptionTypes<typeof builder & typeof sharedOptionsBuilder>;
type GenDevVarsCommandArgv = ArgumentsCamelCase<GenDevVarsCommandOptions & { path?: string }>;

const typeStubPlaceholderValue = '1';

export const genDevVarsCommand: CommandModule<unknown, GenDevVarsCommandOptions> = {
  command: 'gen-dev-vars [path]',
  describe:
    'Generate a .dev.vars file for `wrangler dev` from the environment variables loaded from .env files (plus WB_ENV and NEXT_PUBLIC_WB_ENV). With --for-types, emit a key-only stub for `wrangler types` instead.',
  builder: (yargs) =>
    yargs.options(builder).positional('path', {
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

    const forTypes = Boolean(argv.forTypes);
    // Restrict to variables loaded from the project's declared environment sources so that
    // unrelated process environment variables never leak into the generated file. Ignore
    // process.env because the parent wb process injects the .env values into it, which would
    // otherwise suppress loading them here. wbfy declares the WB_ENV-family keys in fnox, so
    // they are already included; process-only keys are intentionally outside this allowlist.
    const [envVars] = readEnvironmentVariables(argv, project.dirPath, { ignoreProcessEnv: true });
    // Explicitly exported environment variables must win over dotenv values for file-defined
    // keys (project.env applies that precedence), or `AUTH_SECRET=... wb start` would serve
    // the stale file value. An export that empties a non-empty file value is deliberate and
    // must survive the empty-value filter below (unlike `KEY=` placeholders in .env files,
    // which stay omitted so they cannot override wrangler `vars` with empty strings).
    // A type stub needs only key names, so it skips this value adjudication entirely.
    const explicitlyEmptiedKeys = new Set<string>();
    if (!forTypes) {
      for (const key of Object.keys(envVars)) {
        const effectiveValue = project.env[key];
        if (effectiveValue === undefined) continue;
        if (effectiveValue === '' && envVars[key] !== '') explicitlyEmptiedKeys.add(key);
        envVars[key] = effectiveValue;
      }
    }
    const lines = Object.entries(envVars)
      // A type stub keeps every declared key — including empty `KEY=` placeholders — because
      // `wrangler types` types a binding from the key's mere presence. A runtime .dev.vars instead
      // drops empty placeholders so they cannot shadow wrangler `vars` with empty strings.
      .filter(([key, value]) => forTypes || value !== '' || explicitlyEmptiedKeys.has(key))
      .toSorted(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => `${key}=${forTypes ? typeStubPlaceholderValue : quoteDotenvValue(key, value)}`);
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
