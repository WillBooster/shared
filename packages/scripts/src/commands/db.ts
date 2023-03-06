import type { CommandModule } from 'yargs';

import { prismaScripts } from '../scripts/prismaScripts.js';
import { runWithSpawn } from '../scripts/run.js';

export const dbCommand: CommandModule = {
  command: 'db',
  describe: 'Run db commands',
  builder: (yargs) => {
    return yargs
      .command(litestreamCommand)
      .command(migrateCommand)
      .command(migrateDevCommand)
      .command(resetCommand)
      .command(seedCommand)
      .demandCommand();
  },
  handler() {
    // Do nothing
  },
};

const litestreamCommand: CommandModule = {
  command: 'litestream',
  describe: 'Setup DB for Litestream',
  builder: {},
  async handler() {
    await runWithSpawn(prismaScripts.litestream());
  },
};

const migrateCommand: CommandModule = {
  command: 'migrate',
  describe: 'Apply migration files to DB',
  builder: {},
  async handler() {
    await runWithSpawn(prismaScripts.migrate());
  },
};

const migrateDevCommand: CommandModule = {
  command: 'migrate-dev',
  describe: 'Create a migration file',
  builder: {},
  async handler() {
    await runWithSpawn(prismaScripts.migrateDev());
  },
};

const resetCommand: CommandModule = {
  command: 'reset',
  describe: 'Reset DB',
  builder: {},
  async handler() {
    await runWithSpawn(prismaScripts.reset());
  },
};

const seedCommand: CommandModule = {
  command: 'seed',
  describe: 'Populate DB with seed data',
  builder: {},
  async handler() {
    await runWithSpawn(prismaScripts.seed());
  },
};