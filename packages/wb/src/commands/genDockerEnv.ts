import fs from 'node:fs';
import path from 'node:path';

import { resolveCascade } from '@willbooster/shared-lib-node/src';
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
// and the profile comes from the shared cascade resolution, not from loaded sources.
const builder = {} as const;

type GenDockerEnvCommandOptions = InferredOptionTypes<typeof builder & typeof sharedOptionsBuilder>;
type GenDockerEnvCommandArgv = ArgumentsCamelCase<GenDockerEnvCommandOptions & { path?: string }>;

const standardWbEnvModes = new Set(['development', 'test', 'staging', 'production']);

export const genDockerEnvCommand: CommandModule<unknown, GenDockerEnvCommandOptions> = {
  command: 'gen-docker-env [path]',
  describe:
    'Generate a .docker.env file to bake into a Docker image, containing only the non-secret (plaintext default) values of fnox.toml for the selected WB_ENV. Secrets are never written; inject them at runtime from the deployment platform. The file is shell-sourceable dotenv (for a build-time `set -a && . ./.docker.env` and dotenv parsers), not for `docker --env-file`, which keeps quotes literally; runtime entrypoints must apply baked values only to keys the platform did not already set.',
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

    // The shared cascade resolution keeps this command's profile identical to the one every other
    // wb command loads. An unresolved cascade (--auto-cascade-env=false without --cascade-env) or
    // a non-standard mode is a hard error: it would silently bake the base (development) values
    // into a deploy artifact.
    const envName = resolveCascade(argv);
    if (!envName) {
      console.error(
        chalk.red('No environment selected; pass --cascade-env=<mode> (or drop --auto-cascade-env=false).')
      );
      process.exit(1);
    }
    if (!standardWbEnvModes.has(envName)) {
      console.error(chalk.red(`WB_ENV must be one of ${[...standardWbEnvModes].join(', ')}, but is ${envName}.`));
      process.exit(1);
    }

    const envVars = collectPlaintextFnoxValues(project.dirPath, project.rootDirPath, envName);
    // A WB_ENV-family default that disagrees with the selected mode would label the image with a
    // different (possibly misspelled) environment than the one whose values it bakes.
    for (const marker of ['WB_ENV', 'NEXT_PUBLIC_WB_ENV']) {
      const value = envVars[marker];
      if (value !== undefined && value !== envName) {
        console.error(
          chalk.red(`fnox.toml defines ${marker}=${value} for the ${envName} profile; align it with the mode name.`)
        );
        process.exit(1);
      }
    }
    // Code-point order, not localeCompare: the file must be byte-identical across build hosts so
    // Docker layer caching and image reproducibility are locale-independent.
    const lines = Object.entries(envVars)
      .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, value]) => serializeDockerEnvLine(key, value));
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
 * Serialize one `.docker.env` assignment so the SAME bytes are read back by every canonical
 * consumer: POSIX shell sourcing (`set -a && . ./.docker.env` in Dockerfiles and entrypoints) and
 * dotenv-family parsers. Single quotes are the only representation both families treat as a
 * literal span (no expansion, no command substitution), so values fnox would expand (`${...}`
 * references) or that no single-quoted span can hold (apostrophes, newlines), and keys that are
 * not shell identifiers, are rejected with the offending key instead of being written in a form
 * one consumer would corrupt.
 */
export function serializeDockerEnvLine(key: string, value: string): string {
  if (!/^[A-Za-z_]\w*$/.test(key)) {
    throw new Error(`The key ${key} cannot be written to a .docker.env file: it is not a POSIX shell identifier.`);
  }
  // `__proto__` IS a valid shell identifier, but dotenv's parser drops the assignment (the legacy
  // prototype setter swallows it), so the consumers would disagree on the key's very existence.
  if (key === '__proto__') {
    throw new Error(
      `The key __proto__ cannot be written to a .docker.env file: dotenv parsers silently drop a __proto__ assignment.`
    );
  }
  // A bare `$NAME` (which fnox exports literally) is resolved by dotenv-expand-style consumers
  // while shell sourcing keeps it literal, dotenv-expand also rewrites `\$` to `$`, and a residual
  // `${` marks a reference form the collector could not resolve — so any expansion-sensitive `$`
  // makes the consumers disagree. `$` before a digit, space, `(`, or the end of the value is inert
  // in both families and stays representable.
  if (/\$[A-Za-z_${]|\\\$/.test(value)) {
    throw new Error(
      `The value of ${key} contains an expansion-sensitive $ reference; wb gen-docker-env does not expand references — inline the value in fnox.toml.`
    );
  }
  // A trailing backslash makes dotenv's parser read the closing quote as an escaped quote and
  // swallow the following lines, while shell sourcing reads the value correctly.
  if (/['\n\r]/.test(value) || value.endsWith('\\')) {
    throw new Error(
      `The value of ${key} cannot be written to a .docker.env file: apostrophes, newlines, and a trailing backslash are not representable in its single-quoted, shell-sourceable format.`
    );
  }
  return `${key}='${value}'`;
}
