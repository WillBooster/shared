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
      .command(litestreamCommand)
      .command(migrateCommand)
      .command(migrateDevCommand)
      .command(resetCommand)
      .command(seedCommand)
      .command(studioCommand)
      .demandCommand();
  },
  handler() {
    // Do nothing
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
  describe: 'Apply migration files to DB',
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
