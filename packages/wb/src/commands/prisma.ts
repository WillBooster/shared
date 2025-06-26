import type { EnvReaderOptions } from '@willbooster/shared-lib-node/src';
import chalk from 'chalk';
import type { CommandModule, InferredOptionTypes } from 'yargs';

import type { Project } from '../project.js';
import { findDescendantProjects } from '../project.js';
import { prismaScripts } from '../scripts/prismaScripts.js';
import { runWithSpawn } from '../scripts/run.js';
import { sharedOptionsBuilder } from '../sharedOptionsBuilder.js';

import { prepareForRunningCommand } from './commandUtils.js';

const builder = {} as const;

export const prismaCommand: CommandModule = {
  command: 'prisma',
  describe: 'Run prisma commands',
  builder: (yargs) => {
    return yargs
      .command(deployCommand)
      .command(deployForceCommand)
      .command(litestreamCommand)
      .command(migrateCommand)
      .command(migrateDevCommand)
      .command(resetCommand)
      .command(restoreCommand)
      .command(seedCommand)
      .command(studioCommand)
      .command(defaultCommand)
      .demandCommand()
      .strict(false); // Allow unknown options to be passed through
  },
  handler() {
    // Do nothing
  },
};

const deployCommand: CommandModule<unknown, InferredOptionTypes<typeof builder>> = {
  command: 'deploy',
  describe: 'Apply migration to DB without initializing it',
  builder,
  async handler(argv) {
    const allProjects = await findPrismaProjects(argv);
    const unknownOptions = extractUnknownOptions(argv);
    for (const project of prepareForRunningCommand('prisma deploy', allProjects)) {
      await runWithSpawn(prismaScripts.deploy(project, unknownOptions), project, argv);
    }
  },
};

const deployForceBuilder = {
  ...builder,
  'backup-path': {
    description: 'Whether to skip actual command execution',
    demandOption: true,
    type: 'string',
    alias: 'b',
  },
} as const;

const deployForceCommand: CommandModule<unknown, InferredOptionTypes<typeof deployForceBuilder>> = {
  command: 'deploy-force <backup-path>',
  describe: "Force to apply migration to DB utilizing Litestream's backup without initializing it",
  builder: deployForceBuilder,
  async handler(argv) {
    const allProjects = await findPrismaProjects(argv);
    const unknownOptions = extractUnknownOptions(argv, ['backup-path', 'backupPath', 'b']);
    for (const project of prepareForRunningCommand('prisma deploy-force', allProjects)) {
      await runWithSpawn(prismaScripts.deployForce(project, argv.backupPath), project, argv);
    }
  },
};

const litestreamCommand: CommandModule<unknown, InferredOptionTypes<typeof builder>> = {
  command: 'litestream',
  describe: 'Setup DB for Litestream',
  builder,
  async handler(argv) {
    const allProjects = await findPrismaProjects(argv);
    const unknownOptions = extractUnknownOptions(argv);
    for (const project of prepareForRunningCommand('prisma litestream', allProjects)) {
      await runWithSpawn(prismaScripts.litestream(project), project, argv);
    }
  },
};

const migrateCommand: CommandModule<unknown, InferredOptionTypes<typeof builder>> = {
  command: 'migrate',
  describe: 'Apply migration to DB with initializing it',
  builder,
  async handler(argv) {
    const allProjects = await findPrismaProjects(argv);
    const unknownOptions = extractUnknownOptions(argv);
    for (const project of prepareForRunningCommand('prisma migrate', allProjects)) {
      await runWithSpawn(prismaScripts.migrate(project, unknownOptions), project, argv);
    }
  },
};

const migrateDevCommand: CommandModule<unknown, InferredOptionTypes<typeof builder>> = {
  command: 'migrate-dev',
  describe: 'Create a migration file',
  builder,
  async handler(argv) {
    const allProjects = await findPrismaProjects(argv);
    const unknownOptions = extractUnknownOptions(argv);
    for (const project of prepareForRunningCommand('prisma migrate-dev', allProjects)) {
      await runWithSpawn(prismaScripts.migrateDev(project, unknownOptions), project, argv);
    }
  },
};

const resetCommand: CommandModule<unknown, InferredOptionTypes<typeof builder>> = {
  command: 'reset',
  describe: 'Reset DB',
  builder,
  async handler(argv) {
    const allProjects = await findPrismaProjects(argv);
    const unknownOptions = extractUnknownOptions(argv);
    for (const project of prepareForRunningCommand('prisma reset', allProjects)) {
      await runWithSpawn(prismaScripts.reset(project, unknownOptions), project, argv);
    }
  },
};

const restoreBuilder = {
  ...deployForceBuilder,
  output: {
    description: 'Output path of the restored database. Defaults to "<db|prisma>/restored.sqlite3".',
    type: 'string',
  },
} as const;

const restoreCommand: CommandModule<unknown, InferredOptionTypes<typeof restoreBuilder>> = {
  command: 'restore <backup-path>',
  describe: "Restore DB from Litestream's backup",
  builder: restoreBuilder,
  async handler(argv) {
    const allProjects = await findPrismaProjects(argv);
    const unknownOptions = extractUnknownOptions(argv, ['backup-path', 'backupPath', 'b', 'output']);
    for (const project of prepareForRunningCommand('prisma restore', allProjects)) {
      const output =
        argv.output ||
        (project.packageJson.dependencies?.['blitz'] ? 'db/restored.sqlite3' : 'prisma/restored.sqlite3');
      await runWithSpawn(prismaScripts.restore(project, argv.backupPath, output), project, argv);
    }
  },
};

const seedBuilder = {
  ...builder,
  file: {
    alias: 'f',
    description: 'Path of the seed script.',
    type: 'string',
  },
} as const;

const seedCommand: CommandModule<unknown, InferredOptionTypes<typeof seedBuilder>> = {
  command: 'seed',
  describe: 'Populate DB with seed data',
  builder: seedBuilder,
  async handler(argv) {
    const allProjects = await findPrismaProjects(argv);
    const unknownOptions = extractUnknownOptions(argv, ['file', 'f']);
    for (const project of prepareForRunningCommand('prisma seed', allProjects)) {
      await runWithSpawn(prismaScripts.seed(project, argv.file), project, argv);
    }
  },
};

const studioBuilder = {
  ...builder,
  'db-url-or-path': {
    description: 'URL or path to the database',
    type: 'string',
  },
  restored: {
    description: 'Whether to open the default restored database (<db|prisma>/restored.sqlite3).',
    type: 'boolean',
  },
} as const;

const studioCommand: CommandModule<unknown, InferredOptionTypes<typeof studioBuilder>> = {
  command: 'studio [db-url-or-path]',
  describe: 'Open Prisma Studio',
  builder: studioBuilder,
  async handler(argv) {
    if (argv.restored && argv.dbUrlOrPath) {
      throw new Error('You cannot specify both --restored and --db-url-or-path.');
    }

    const allProjects = await findPrismaProjects(argv);
    const unknownOptions = extractUnknownOptions(argv, ['db-url-or-path', 'restored']);
    for (const project of prepareForRunningCommand('prisma studio', allProjects)) {
      const dbUrlOrPath = argv.restored
        ? project.packageJson.dependencies?.['blitz']
          ? 'db/restored.sqlite3'
          : 'prisma/restored.sqlite3'
        : argv.dbUrlOrPath?.toString();
      await runWithSpawn(prismaScripts.studio(project, dbUrlOrPath, unknownOptions), project, argv);
    }
  },
};

const defaultCommandBuilder = { args: { type: 'array' } } as const;

const defaultCommand: CommandModule<unknown, InferredOptionTypes<typeof defaultCommandBuilder>> = {
  command: '$0 <args..>',
  describe: 'Pass the command and arguments to prisma as is',
  builder: defaultCommandBuilder,
  async handler(argv) {
    const allProjects = await findPrismaProjects(argv);
    const script = `${argv.args?.join(' ') ?? ''}`.trimEnd();
    const unknownOptions = extractUnknownOptions(argv, ['args']);
    const fullCommand = [script, unknownOptions].filter(Boolean).join(' ');
    for (const project of prepareForRunningCommand(`prisma ${fullCommand}`, allProjects)) {
      await runWithSpawn(`PRISMA ${fullCommand}`, project, argv);
    }
  },
};

async function findPrismaProjects(argv: EnvReaderOptions): Promise<Project[]> {
  const projects = await findDescendantProjects(argv);
  if (!projects) {
    console.error(chalk.red('No project found.'));
    process.exit(1);
  }

  const filtered = projects.descendants.filter(
    (project) => project.packageJson.dependencies?.['prisma'] || project.packageJson.devDependencies?.['prisma']
  );
  if (filtered.length === 0) {
    console.error(chalk.red('No prisma project found.'));
    process.exit(1);
  }
  return filtered;
}

/**
 * Extract unknown options from argv to pass to prisma command
 */
export function extractUnknownOptions(argv: Record<string, unknown>, knownOptions: string[] = []): string {
  const unknownOptions: string[] = [];

  // Build list of known options from shared options builders
  const sharedOptionKeys = Object.keys(sharedOptionsBuilder);
  const sharedOptionAliases = Object.values(sharedOptionsBuilder)
    .flatMap((option) => {
      if ('alias' in option && option.alias) {
        return Array.isArray(option.alias) ? option.alias : [option.alias];
      }
      return [];
    })
    .map(String);

  const allKnownOptions = new Set([
    ...knownOptions,
    ...sharedOptionKeys,
    ...sharedOptionAliases,
    // Internal yargs properties
    '_',
    '$0',
  ]);

  for (const [key, value] of Object.entries(argv)) {
    if (!allKnownOptions.has(key)) {
      // Skip camelCase versions of kebab-case options to avoid duplication
      // If we have both 'create-only' and 'createOnly', prefer the kebab-case version
      const kebabCaseKey = key.replaceAll(/[A-Z]/g, (match) => `-${match.toLowerCase()}`);
      if (kebabCaseKey !== key && argv[kebabCaseKey] !== undefined) {
        continue; // Skip camelCase version if kebab-case exists
      }

      // Handle boolean flags
      if (typeof value === 'boolean' && value) {
        unknownOptions.push(`--${key}`);
      }
      // Handle string/number values
      else if (typeof value === 'string' || typeof value === 'number') {
        unknownOptions.push(`--${key}`, String(value));
      }
      // Handle arrays
      else if (Array.isArray(value)) {
        for (const item of value) {
          unknownOptions.push(`--${key}`, String(item));
        }
      }
    }
  }

  return unknownOptions.join(' ');
}
