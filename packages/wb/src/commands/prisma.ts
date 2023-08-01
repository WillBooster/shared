import type { CommandModule, InferredOptionTypes } from 'yargs';

import { prismaScripts } from '../scripts/prismaScripts.js';
import { runWithSpawn } from '../scripts/run.js';
import { sharedOptions } from '../sharedOptions.js';

const builder = {
  ...sharedOptions,
} as const;

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
    await runWithSpawn(prismaScripts.deploy(), argv);
  },
};

const deployForceAndRestoreBuilder = {
  ...sharedOptions,
  'backup-path': {
    description: 'Whether to skip actual command execution',
    required: true,
    type: 'string',
  },
} as const;

const deployForceCommand: CommandModule<unknown, InferredOptionTypes<typeof deployForceAndRestoreBuilder>> = {
  command: 'deploy-force',
  describe: "Force to apply migration to DB utilizing Litestream's backup without initializing it",
  builder,
  async handler(argv) {
    await runWithSpawn(prismaScripts.deployForce(argv.backupPath), argv);
  },
};

const litestreamCommand: CommandModule<unknown, InferredOptionTypes<typeof builder>> = {
  command: 'litestream',
  describe: 'Setup DB for Litestream',
  builder,
  async handler(argv) {
    await runWithSpawn(prismaScripts.litestream(), argv);
  },
};

const migrateCommand: CommandModule<unknown, InferredOptionTypes<typeof builder>> = {
  command: 'migrate',
  describe: 'Apply migration to DB with initializing it',
  builder,
  async handler(argv) {
    await runWithSpawn(prismaScripts.migrate(), argv);
  },
};

const migrateDevCommand: CommandModule<unknown, InferredOptionTypes<typeof builder>> = {
  command: 'migrate-dev',
  describe: 'Create a migration file',
  builder,
  async handler(argv) {
    await runWithSpawn(prismaScripts.migrateDev(), argv);
  },
};

const resetCommand: CommandModule<unknown, InferredOptionTypes<typeof builder>> = {
  command: 'reset',
  describe: 'Reset DB',
  builder,
  async handler(argv) {
    await runWithSpawn(prismaScripts.reset(), argv);
  },
};

const restoreCommand: CommandModule<unknown, InferredOptionTypes<typeof deployForceAndRestoreBuilder>> = {
  command: 'restore',
  describe: "Restore DB from Litestream's backup",
  builder,
  async handler(argv) {
    await runWithSpawn(prismaScripts.restore(argv.backupPath), argv);
  },
};

const seedCommand: CommandModule<unknown, InferredOptionTypes<typeof builder>> = {
  command: 'seed',
  describe: 'Populate DB with seed data',
  builder,
  async handler(argv) {
    await runWithSpawn(prismaScripts.seed(), argv);
  },
};

const studioCommand: CommandModule<unknown, InferredOptionTypes<typeof builder>> = {
  command: 'studio',
  describe: 'Open Prisma Studio',
  builder,
  async handler(argv) {
    await runWithSpawn(prismaScripts.studio(), argv);
  },
};
