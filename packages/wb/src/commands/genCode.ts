import fs from 'node:fs';
import path from 'node:path';

import chalk from 'chalk';
import type { ArgumentsCamelCase, CommandModule, InferredOptionTypes } from 'yargs';

import type { Project } from '../project.js';
import { findDescendantProjects } from '../project.js';
import { runWithSpawn } from '../scripts/run.js';
import type { sharedOptionsBuilder } from '../sharedOptionsBuilder.js';

import { prepareForRunningCommand } from './commandUtils.js';

const builder = {
  'chakra-strict': {
    description: 'Pass --strict to Chakra UI v3 typegen.',
    type: 'boolean',
    default: false,
  },
} as const;

type GenCodeCommandOptions = InferredOptionTypes<typeof builder & typeof sharedOptionsBuilder>;
type GenCodeCommandArgv = ArgumentsCamelCase<GenCodeCommandOptions>;

export const genCodeCommand: CommandModule<unknown, GenCodeCommandOptions> = {
  command: 'gen-code',
  describe: 'Generate code for the current project',
  builder,
  async handler(argv) {
    const projects = await findDescendantProjects(argv);
    if (!projects) {
      console.error(chalk.red('No project found.'));
      process.exit(1);
    }

    let generated = false;
    for (const project of prepareForRunningCommand('gen-code', projects.descendants)) {
      const scripts = getGenCodeScripts(project, argv);
      if (scripts.length === 0) {
        console.info(chalk.yellow(`No code generation needed for ${project.name}.`));
        continue;
      }
      generated = true;
      for (const script of scripts) {
        await runWithSpawn(script, project, argv);
      }
    }

    if (!generated) {
      console.info(chalk.green('No code generation needed.'));
    }
  },
};

function getGenCodeScripts(project: Project, argv: GenCodeCommandArgv): string[] {
  const scripts: string[] = [];
  if (project.hasOwnDependency('blitz')) {
    scripts.push('YARN blitz codegen');
    if (project.hasPrisma) {
      scripts.push('YARN blitz prisma generate');
    }
  } else if (project.hasPrisma) {
    scripts.push('PRISMA generate');
  }

  const chakraTypegenScript = getChakraTypegenScript(project, argv.chakraStrict);
  if (chakraTypegenScript) {
    scripts.push(chakraTypegenScript);
  }

  const drizzleConfigPath = project.hasDrizzle ? getDrizzleConfigPath(project) : undefined;
  // Existing Drizzle+Chakra repositories only generated Chakra types. Keep the
  // Drizzle compatibility check limited to Drizzle-only gen-code scripts.
  if (scripts.length === 0 && drizzleConfigPath) {
    scripts.push(`YARN drizzle-kit check --config ${drizzleConfigPath} || true`);
  }
  return scripts;
}

function getChakraTypegenScript(project: Project, useStrict: boolean): string | undefined {
  if (!project.hasOwnDependency('@chakra-ui/cli')) return;

  if (fs.existsSync(path.join(project.dirPath, 'src', 'core', 'theme.ts'))) {
    return 'YARN chakra-cli tokens src/core/theme.ts';
  }
  if (fs.existsSync(path.join(project.dirPath, 'src', 'theme.ts'))) {
    return `YARN chakra typegen src/theme.ts${useStrict ? ' --strict' : ''}`;
  }
  return;
}

function getDrizzleConfigPath(project: Project): string | undefined {
  const candidates = ['drizzle.config.ts', 'drizzle.config.mts', 'drizzle.config.js', 'drizzle.config.mjs'];
  return candidates.find((filePath) => fs.existsSync(path.join(project.dirPath, filePath)));
}
