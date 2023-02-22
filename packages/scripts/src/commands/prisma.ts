import fs from 'node:fs/promises';

import { PackageJson } from 'type-fest';
import type { CommandModule } from 'yargs';

import { prismaScripts } from '../scripts/prismaScripts.js';
import { runWithSpawn } from '../scripts/run.js';

export const prismaCommand: CommandModule = {
  command: 'prisma',
  describe: 'Run prisma commands',
  builder: (yargs) => {
    return yargs
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

const migrateCommand: CommandModule = {
  command: 'migrate',
  describe: 'Apply migration files to DB',
  builder: {},
  async handler() {
    const packageJson = JSON.parse(await fs.readFile('package.json', 'utf8')) as PackageJson;
    await runWithSpawn(prismaScripts.migrate(packageJson));
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
    const packageJson = JSON.parse(await fs.readFile('package.json', 'utf8')) as PackageJson;
    await runWithSpawn(prismaScripts.reset(packageJson));
  },
};

const seedCommand: CommandModule = {
  command: 'seed',
  describe: 'Populate DB with seed data',
  builder: {},
  async handler() {
    const packageJson = JSON.parse(await fs.readFile('package.json', 'utf8')) as PackageJson;
    await runWithSpawn(prismaScripts.seed(packageJson));
  },
};
