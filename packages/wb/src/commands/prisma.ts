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
    const [root, ...allProjects] = await findPrismaProjects();
    for (const project of prepareForRunningCommand('prisma deploy', root, allProjects, argv)) {
      await runWithSpawn(prismaScripts.deploy(project), argv);
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
    const [root, ...allProjects] = await findPrismaProjects();
    for (const project of prepareForRunningCommand('prisma deploy-force', root, allProjects, argv)) {
      await runWithSpawn(prismaScripts.deployForce(project, argv.backupPath), argv);
    }
  },
};

const litestreamCommand: CommandModule<unknown, InferredOptionTypes<typeof builder>> = {
  command: 'litestream',
  describe: 'Setup DB for Litestream',
  builder,
  async handler(argv) {
    const [root, ...allProjects] = await findPrismaProjects();
    for (const project of prepareForRunningCommand('prisma litestream', root, allProjects, argv)) {
      await runWithSpawn(prismaScripts.litestream(project), argv);
    }
  },
};

const migrateCommand: CommandModule<unknown, InferredOptionTypes<typeof builder>> = {
  command: 'migrate',
  describe: 'Apply migration to DB with initializing it',
  builder,
  async handler(argv) {
    const [root, ...allProjects] = await findPrismaProjects();
    for (const project of prepareForRunningCommand('prisma migrate', root, allProjects, argv)) {
      await runWithSpawn(prismaScripts.migrate(project), argv);
    }
  },
};

const migrateDevCommand: CommandModule<unknown, InferredOptionTypes<typeof builder>> = {
  command: 'migrate-dev',
  describe: 'Create a migration file',
  builder,
  async handler(argv) {
    const [root, ...allProjects] = await findPrismaProjects();
    for (const project of prepareForRunningCommand('prisma migrate-dev', root, allProjects, argv)) {
      await runWithSpawn(prismaScripts.migrateDev(project), argv);
    }
  },
};

const resetCommand: CommandModule<unknown, InferredOptionTypes<typeof builder>> = {
  command: 'reset',
  describe: 'Reset DB',
  builder,
  async handler(argv) {
    const [root, ...allProjects] = await findPrismaProjects();
    for (const project of prepareForRunningCommand('prisma reset', root, allProjects, argv)) {
      await runWithSpawn(prismaScripts.reset(project), argv);
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
    const [root, ...allProjects] = await findPrismaProjects();
    for (const project of prepareForRunningCommand('prisma restore', root, allProjects, argv)) {
      const output =
        argv.output ||
        (project.packageJson.dependencies?.['blitz'] ? 'db/restored.sqlite3' : 'prisma/restored.sqlite3');
      await runWithSpawn(prismaScripts.restore(project, argv.backupPath, output), argv);
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
    const [root, ...allProjects] = await findPrismaProjects();
    for (const project of prepareForRunningCommand('prisma seed', root, allProjects, argv)) {
      await runWithSpawn(prismaScripts.seed(project, argv.file), argv);
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

    const [root, ...allProjects] = await findPrismaProjects();
    for (const project of prepareForRunningCommand('prisma studio', root, allProjects, argv)) {
      const dbUrlOrPath = argv.restored
        ? project.packageJson.dependencies?.['blitz']
          ? 'db/restored.sqlite3'
          : 'prisma/restored.sqlite3'
        : argv.dbUrlOrPath?.toString();
      await runWithSpawn(prismaScripts.studio(project, dbUrlOrPath), argv);
    }
  },
};

async function findPrismaProjects(): Promise<Project[]> {
  const projects = await findAllProjects();
  if (!projects) return [];

  const prismaProjects = projects.all.filter(
    (project) => project.packageJson.dependencies?.['prisma'] || project.packageJson.devDependencies?.['prisma']
  );
  return [projects.root, ...prismaProjects];
}
