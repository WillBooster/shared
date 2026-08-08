import fs from 'node:fs';
import path from 'node:path';

import chalk from 'chalk';
import type { ArgumentsCamelCase, Argv, CommandModule, InferredOptionTypes } from 'yargs';

import { findSelfProject } from '../project.js';
import type { sharedOptionsBuilder } from '../sharedOptionsBuilder.js';
import { collectPlaintextFnoxValues } from '../utils/fnoxToml.js';

// A Docker image must bake only values that are safe to persist in layers and registries: the
// plaintext `{ default = "..." }` entries of fnox.toml. Age-encrypted secrets are resolved at
// runtime from the deployment platform's store instead, and the age key never enters an image.
// The whole command therefore works from the committed fnox.toml text alone: the project is
// loaded WITHOUT its environment (loading would spawn `fnox export`, i.e. decrypt every secret)
// and the profile is selected from the command line and the ambient WB_ENV only.
const builder = {} as const;

type GenDockerEnvCommandOptions = InferredOptionTypes<typeof builder & typeof sharedOptionsBuilder>;
type GenDockerEnvCommandArgv = ArgumentsCamelCase<GenDockerEnvCommandOptions & { path?: string }>;

const standardWbEnvModes = new Set(['development', 'test', 'staging', 'production']);

export const genDockerEnvCommand: CommandModule<unknown, GenDockerEnvCommandOptions> = {
  command: 'gen-docker-env [path]',
  describe:
    'Generate a .docker.env file to bake into a Docker image, containing only the non-secret (plaintext default) values of fnox.toml for the selected WB_ENV. Secrets are never written; inject them at runtime from the deployment platform. The file is shell-sourceable dotenv (for `set -a && . ./.docker.env` and dotenv parsers), not for `docker --env-file`, which keeps quotes literally.',
  builder: (yargs) =>
    yargs.positional('path', {
      description: 'Output path of the generated .docker.env file.',
      type: 'string',
      default: '.docker.env',
    }) as unknown as Argv<GenDockerEnvCommandOptions>,
  async handler(argv: GenDockerEnvCommandArgv) {
    const project = findSelfProject(argv, false);
    if (!project) {
      console.error(chalk.red('No project found.'));
      process.exit(1);
    }

    // Mirror wb's own profile selection (--cascade-env first, then the exported WB_ENV) without
    // loading environment sources. A non-standard mode is a hard error: it would silently bake
    // the base (development) values into a deploy artifact.
    const envName = argv.cascadeEnv || process.env.WB_ENV || 'development';
    if (!standardWbEnvModes.has(envName)) {
      console.error(chalk.red(`WB_ENV must be one of ${[...standardWbEnvModes].join(', ')}, but is ${envName}.`));
      process.exit(1);
    }

    const envVars = collectPlaintextFnoxValues(project.dirPath, project.rootDirPath, envName);
    const lines = Object.entries(envVars)
      .toSorted(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => `${key}=${quoteShellSourceableValue(key, value)}`);
    const outputPath = path.resolve(project.dirPath, argv.path ?? '.docker.env');
    if (argv.dryRun) {
      console.info(
        chalk.cyan(`Would generate ${outputPath} with ${lines.length} non-secret environment variables (${envName}).`)
      );
      return;
    }

    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, lines.join('\n') + '\n');
    console.info(
      chalk.green(`Generated ${outputPath} with ${lines.length} non-secret environment variables (${envName}).`)
    );
  },
};

/**
 * Quote a value so the SAME bytes are read back by every canonical `.docker.env` consumer: POSIX
 * shell sourcing (`set -a && . ./.docker.env` in Dockerfiles and entrypoints) and dotenv-family
 * parsers. Single quotes are the only representation both families treat as a literal span (no
 * expansion, no command substitution), and neither family can represent an embedded apostrophe or
 * newline inside one, so such values are rejected with the offending key instead of being written
 * in a form one consumer would corrupt.
 */
export function quoteShellSourceableValue(key: string, value: string): string {
  if (/['\n\r]/.test(value)) {
    throw new Error(
      `The value of ${key} cannot be written to a .docker.env file: apostrophes and newlines are not representable in its single-quoted, shell-sourceable format.`
    );
  }
  return `'${value}'`;
}
