import type { EnvReaderOptions } from '@willbooster/shared-lib-node/src';
import chalk from 'chalk';
import type { CommandModule, InferredOptionTypes } from 'yargs';

import type { Project } from '../project.js';
import { findAllProjects } from '../project.js';
import { prismaScripts } from '../scripts/prismaScripts.js';
import { runWithSpawn } from '../scripts/run.js';

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
      .demandCommand();
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
    for (const project of prepareForRunningCommand('prisma deploy', allProjects)) {
      await runWithSpawn(prismaScripts.deploy(project), project, argv);
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
    for (const project of prepareForRunningCommand('prisma migrate', allProjects)) {
      await runWithSpawn(prismaScripts.migrate(project), project, argv);
    }
  },
};

const migrateDevCommand: CommandModule<unknown, InferredOptionTypes<typeof builder>> = {
  command: 'migrate-dev',
  describe: 'Create a migration file',
  builder,
  async handler(argv) {
    const allProjects = await findPrismaProjects(argv);
    for (const project of prepareForRunningCommand('prisma migrate-dev', allProjects)) {
      await runWithSpawn(prismaScripts.migrateDev(project), project, argv);
    }
  },
};

const resetCommand: CommandModule<unknown, InferredOptionTypes<typeof builder>> = {
  command: 'reset',
  describe: 'Reset DB',
  builder,
  async handler(argv) {
    const allProjects = await findPrismaProjects(argv);
    for (const project of prepareForRunningCommand('prisma reset', allProjects)) {
      await runWithSpawn(prismaScripts.reset(project), project, argv);
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
    for (const project of prepareForRunningCommand('prisma studio', allProjects)) {
      const dbUrlOrPath = argv.restored
        ? project.packageJson.dependencies?.['blitz']
          ? 'db/restored.sqlite3'
          : 'prisma/restored.sqlite3'
        : argv.dbUrlOrPath?.toString();
      await runWithSpawn(prismaScripts.studio(project, dbUrlOrPath), project, argv);
    }
  },
};

const defaultCommandBuilder = { args: { type: 'array' } } as const;

const defaultCommand: CommandModule<unknown, InferredOptionTypes<typeof defaultCommandBuilder>> = {
  command: '$0 [args..]',
  describe: 'Pass the command and arguments to prisma as is',
  builder: defaultCommandBuilder,
  async handler(argv) {
    const allProjects = await findPrismaProjects(argv);
    const script = `${argv.args?.join(' ') ?? ''}`.trimEnd();
    for (const project of prepareForRunningCommand(`prisma ${script}`, allProjects)) {
      await runWithSpawn(`PRISMA ${script}`, project, argv);
    }
  },
};

async function findPrismaProjects(argv: EnvReaderOptions): Promise<Project[]> {
  const projects = await findAllProjects(argv);
  if (!projects) {
    console.error(chalk.red('No project found.'));
    process.exit(1);
  }

  const filtered = projects.all.filter(
    (project) => project.packageJson.dependencies?.['prisma'] || project.packageJson.devDependencies?.['prisma']
  );
  if (filtered.length === 0) {
    console.error(chalk.red('No prisma project found.'));
    process.exit(1);
  }
  return filtered;
}
