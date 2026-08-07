import fs from 'node:fs';
import path from 'node:path';

import chalk from 'chalk';
import type { ArgumentsCamelCase, Argv, CommandModule, InferredOptionTypes } from 'yargs';

import { findSelfProject } from '../project.js';
import type { sharedOptionsBuilder } from '../sharedOptionsBuilder.js';
import { collectPlaintextFnoxValues } from '../utils/fnoxToml.js';

import { quoteDotenvValue } from './genDevVars.js';

// A Docker image must bake only values that are safe to persist in layers and registries: the
// plaintext `{ default = "..." }` entries of fnox.toml. Age-encrypted secrets are resolved at
// runtime from the deployment platform's store instead, and the age key never enters an image,
// so this command parses fnox.toml statically and never decrypts anything.
const builder = {} as const;

type GenDockerEnvCommandOptions = InferredOptionTypes<typeof builder & typeof sharedOptionsBuilder>;
type GenDockerEnvCommandArgv = ArgumentsCamelCase<GenDockerEnvCommandOptions & { path?: string }>;

export const genDockerEnvCommand: CommandModule<unknown, GenDockerEnvCommandOptions> = {
  command: 'gen-docker-env [path]',
  describe:
    'Generate a .docker.env file to bake into a Docker image, containing only the non-secret (plaintext default) values of fnox.toml for the selected WB_ENV. Secrets are never written; inject them at runtime from the deployment platform.',
  builder: (yargs) =>
    yargs.positional('path', {
      description: 'Output path of the generated .docker.env file.',
      type: 'string',
      default: '.docker.env',
    }) as unknown as Argv<GenDockerEnvCommandOptions>,
  async handler(argv: GenDockerEnvCommandArgv) {
    const project = findSelfProject(argv);
    if (!project) {
      console.error(chalk.red('No project found.'));
      process.exit(1);
    }

    // project.env validates WB_ENV (and derives it for local runs), so the selected profile is
    // always a declared mode; entrypoints let runtime-provided variables win over these baked ones.
    const envName = project.env.WB_ENV;
    const envVars = collectPlaintextFnoxValues(project.dirPath, project.rootDirPath, envName);
    const lines = Object.entries(envVars)
      .filter(([, value]) => value !== '')
      .toSorted(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => `${key}=${quoteDotenvValue(key, value)}`);
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
