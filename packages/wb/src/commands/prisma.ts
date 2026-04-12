import fs from 'node:fs';

import type { EnvReaderOptions } from '@willbooster/shared-lib-node/src';
import chalk from 'chalk';
import type { CommandModule, InferredOptionTypes } from 'yargs';

import type { DatabaseOrm, Project } from '../project.js';
import { findDescendantProjects } from '../project.js';
import { drizzleScripts } from '../scripts/drizzleScripts.js';
import { prismaScripts } from '../scripts/prismaScripts.js';
import { runWithSpawn } from '../scripts/run.js';
import { sharedOptionsBuilder } from '../sharedOptionsBuilder.js';
import { buildShellCommand } from '../utils/shell.js';

import { prepareForRunningCommand } from './commandUtils.js';

const builder = {} as const;

export const prismaCommand: CommandModule = {
  command: 'prisma',
  aliases: ['db'],
  describe:
    "Run database commands. Use '--' to stop wb option parsing and forward the remaining arguments to Prisma. Drizzle projects use drizzle-kit. Example: wb prisma migrate-dev -- --name init",
  builder: (yargs) => {
    return yargs
      .parserConfiguration({ 'populate--': true })
      .command(cleanUpLitestreamCommand)
      .command(createLitestreamConfigCommand)
      .command(deployCommand)
      .command(deployForceCommand)
      .command(listBackupsCommand)
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

const cleanUpLitestreamCommand: CommandModule<unknown, InferredOptionTypes<typeof builder>> = {
  command: 'cleanup-litestream',
  describe: 'Clean up temporal Litestream files',
  builder,
  async handler(argv) {
    const allProjects = await findDatabaseOrmProjects(argv, 'prisma');
    for (const { project } of prepareForRunningDatabaseOrmCommand('prisma cleanup-litestream', allProjects)) {
      await runWithSpawn(prismaScripts.cleanUpLitestream(project), project, argv);
    }
  },
};

const createLitestreamConfigCommand: CommandModule<unknown, InferredOptionTypes<typeof builder>> = {
  command: 'create-litestream-config',
  describe: 'Create Litestream configuration file',
  builder,
  async handler(argv) {
    const allProjects = await findDatabaseOrmProjects(argv, 'prisma');
    for (const { project } of prepareForRunningDatabaseOrmCommand('prisma create-litestream-config', allProjects)) {
      createLitestreamConfig(project);
    }
  },
};

const deployCommand: CommandModule<unknown, InferredOptionTypes<typeof builder>> = {
  command: 'deploy',
  describe: 'Apply migration to DB without initializing it',
  builder,
  async handler(argv) {
    const allProjects = await findDatabaseOrmProjects(argv);
    const unknownOptions = extractUnknownOptions(argv);
    for (const { orm, project } of prepareForRunningDatabaseOrmCommand('db deploy', allProjects)) {
      await runWithSpawn(getDatabaseOrmScripts(orm).deploy(project, unknownOptions), project, argv);
    }
  },
};

const deployForceCommand: CommandModule<unknown, InferredOptionTypes<typeof builder>> = {
  command: 'deploy-force',
  describe: "Force to apply migration to DB utilizing Litestream's backup without initializing it",
  builder,
  async handler(argv) {
    const allProjects = await findDatabaseOrmProjects(argv, 'prisma');
    for (const { project } of prepareForRunningDatabaseOrmCommand('prisma deploy-force', allProjects)) {
      await runWithSpawn(prismaScripts.deployForce(project), project, argv);
    }
  },
};

const listBackupsCommand: CommandModule<unknown, InferredOptionTypes<typeof builder>> = {
  command: 'list-backups',
  describe: 'List Litestream backups',
  builder,
  async handler(argv) {
    const allProjects = await findDatabaseOrmProjects(argv, 'prisma');
    for (const { project } of prepareForRunningDatabaseOrmCommand('prisma list-backups', allProjects)) {
      await runWithSpawn(prismaScripts.listBackups(project), project, argv);
    }
  },
};

const migrateCommand: CommandModule<unknown, InferredOptionTypes<typeof builder>> = {
  command: 'migrate',
  describe: 'Apply migration to DB with initializing it',
  builder,
  async handler(argv) {
    const allProjects = await findDatabaseOrmProjects(argv);
    const unknownOptions = extractUnknownOptions(argv);
    for (const { orm, project } of prepareForRunningDatabaseOrmCommand('db migrate', allProjects)) {
      await runWithSpawn(getDatabaseOrmScripts(orm).migrate(project, unknownOptions), project, argv);
    }
  },
};

const migrateDevCommand: CommandModule<unknown, InferredOptionTypes<typeof builder>> = {
  command: 'migrate-dev',
  describe: 'Create a migration file',
  builder,
  async handler(argv) {
    const allProjects = await findDatabaseOrmProjects(argv);
    const unknownOptions = extractUnknownOptions(argv);
    for (const { orm, project } of prepareForRunningDatabaseOrmCommand('db migrate-dev', allProjects)) {
      await runWithSpawn(getDatabaseOrmScripts(orm).migrateDev(project, unknownOptions), project, argv);
    }
  },
};

const resetCommand: CommandModule<unknown, InferredOptionTypes<typeof builder>> = {
  command: 'reset',
  describe: 'Reset DB',
  builder,
  async handler(argv) {
    const allProjects = await findDatabaseOrmProjects(argv);
    const unknownOptions = extractUnknownOptions(argv);
    for (const { orm, project } of prepareForRunningDatabaseOrmCommand('db reset', allProjects)) {
      await runWithSpawn(getDatabaseOrmScripts(orm).reset(project, unknownOptions), project, argv);
    }
    // Force to reset test database
    if (process.env.WB_ENV !== 'test') {
      process.env.WB_ENV = 'test';
      for (const { orm, project } of prepareForRunningDatabaseOrmCommand(
        'WB_ENV=test db reset',
        await findDatabaseOrmProjects(argv)
      )) {
        await runWithSpawn(getDatabaseOrmScripts(orm).reset(project, unknownOptions), project, argv);
      }
    }
  },
};

const restoreBuilder = {
  ...builder,
  output: {
    description: 'Output path of the restored database. Defaults to "<db|prisma>/restored.sqlite3".',
    type: 'string',
  },
} as const;

const restoreCommand: CommandModule<unknown, InferredOptionTypes<typeof restoreBuilder>> = {
  command: 'restore',
  describe: "Restore DB from Litestream's backup",
  builder: restoreBuilder,
  async handler(argv) {
    const allProjects = await findDatabaseOrmProjects(argv, 'prisma');
    for (const { project } of prepareForRunningDatabaseOrmCommand('prisma restore', allProjects)) {
      const output =
        argv.output ?? (project.packageJson.dependencies?.blitz ? 'db/restored.sqlite3' : 'prisma/restored.sqlite3');
      await runWithSpawn(prismaScripts.restore(project, output), project, argv);
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
    const allProjects = await findDatabaseOrmProjects(argv);
    for (const { orm, project } of prepareForRunningDatabaseOrmCommand('db seed', allProjects)) {
      await runWithSpawn(getDatabaseOrmScripts(orm).seed(project, argv.file), project, argv);
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
  describe: 'Open database studio',
  builder: studioBuilder,
  async handler(argv) {
    if (argv.restored && argv.dbUrlOrPath) {
      throw new Error('You cannot specify both --restored and --db-url-or-path.');
    }

    const allProjects = await findDatabaseOrmProjects(argv);
    const unknownOptions = extractUnknownOptions(argv, ['db-url-or-path', 'restored']);
    for (const { orm, project } of prepareForRunningDatabaseOrmCommand('db studio', allProjects)) {
      const dbUrlOrPath = argv.restored
        ? project.packageJson.dependencies?.blitz
          ? 'db/restored.sqlite3'
          : 'prisma/restored.sqlite3'
        : argv.dbUrlOrPath?.toString();
      await runWithSpawn(getDatabaseOrmScripts(orm).studio(project, dbUrlOrPath, unknownOptions), project, argv);
    }
  },
};

const defaultCommandBuilder = { args: { type: 'array' } } as const;

const defaultCommand: CommandModule<unknown, InferredOptionTypes<typeof defaultCommandBuilder>> = {
  command: '$0 <args..>',
  describe:
    "Pass the command and arguments to the detected ORM as is. Additional Prisma flags can also be forwarded after '--'.",
  builder: defaultCommandBuilder,
  async handler(argv) {
    const allProjects = await findDatabaseOrmProjects(argv);
    const script = (argv.args?.join(' ') ?? '').trimEnd();
    const unknownOptions = extractUnknownOptions(argv, ['args']);
    const fullCommand = [script, unknownOptions].filter(Boolean).join(' ');
    for (const { orm, project } of prepareForRunningDatabaseOrmCommand(`db ${fullCommand}`, allProjects)) {
      const command = orm === 'prisma' ? `PRISMA ${fullCommand}` : `YARN drizzle-kit ${fullCommand}`;
      await runWithSpawn(command, project, argv);
    }
  },
};

function createLitestreamConfig(project: Project): void {
  const dirName = project.packageJson.dependencies?.blitz ? 'db' : 'prisma';
  const dbPath = `${dirName}/mount/prod.sqlite3`;
  const requiredEnvVars = {
    CLOUDFLARE_R2_LITESTREAM_ACCOUNT_ID: project.env.CLOUDFLARE_R2_LITESTREAM_ACCOUNT_ID,
    CLOUDFLARE_R2_LITESTREAM_BUCKET_NAME: project.env.CLOUDFLARE_R2_LITESTREAM_BUCKET_NAME,
    CLOUDFLARE_R2_LITESTREAM_ACCESS_KEY_ID: project.env.CLOUDFLARE_R2_LITESTREAM_ACCESS_KEY_ID,
    CLOUDFLARE_R2_LITESTREAM_SECRET_ACCESS_KEY: project.env.CLOUDFLARE_R2_LITESTREAM_SECRET_ACCESS_KEY,
  } as const;
  const missingEnvVars = Object.entries(requiredEnvVars)
    .filter(([, value]) => !value)
    .map(([key]) => key);
  if (missingEnvVars.length > 0) {
    throw new Error(`Missing environment variables for Litestream: ${missingEnvVars.join(', ')}`);
  }

  const retentionCheckInterval = project.env.WB_ENV === 'staging' ? '5m' : '1h';
  const litestreamConfig = `dbs:
  - path: ${dbPath}
    busy-timeout: 5s
    checkpoint-interval: 1m
    replica:
      type: s3
      endpoint: https://${requiredEnvVars.CLOUDFLARE_R2_LITESTREAM_ACCOUNT_ID}.r2.cloudflarestorage.com
      bucket: ${requiredEnvVars.CLOUDFLARE_R2_LITESTREAM_BUCKET_NAME}
      access-key-id: ${requiredEnvVars.CLOUDFLARE_R2_LITESTREAM_ACCESS_KEY_ID}
      secret-access-key: ${requiredEnvVars.CLOUDFLARE_R2_LITESTREAM_SECRET_ACCESS_KEY}
      snapshot-interval: 24h  # Create a backup per day
      retention: 72h          # Keep backups for 3 days
      retention-check-interval: ${retentionCheckInterval}
      sync-interval: 1m
`;

  const configPath = '/etc/litestream.yml';
  try {
    fs.writeFileSync(configPath, litestreamConfig);
    console.info(`Generated ${configPath}`);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to write ${configPath}: ${reason}`, {
      cause: error,
    });
  }
}

interface DatabaseOrmProject {
  project: Project;
  orm: DatabaseOrm;
}

async function findDatabaseOrmProjects(argv: EnvReaderOptions, orm?: DatabaseOrm): Promise<DatabaseOrmProject[]> {
  const projects = await findDescendantProjects(argv);
  if (!projects) {
    console.error(chalk.red('No project found.'));
    process.exit(1);
  }

  const filtered = projects.descendants
    .map((project) => (project.databaseOrm ? { project, orm: project.databaseOrm } : undefined))
    .filter((project): project is DatabaseOrmProject => !!project && (!orm || project.orm === orm));
  if (filtered.length === 0) {
    console.error(chalk.red(orm ? `No ${orm} project found.` : 'No supported database ORM project found.'));
    process.exit(1);
  }
  return filtered;
}

function getDatabaseOrmScripts(orm: DatabaseOrm): typeof prismaScripts | typeof drizzleScripts {
  return orm === 'prisma' ? prismaScripts : drizzleScripts;
}

function* prepareForRunningDatabaseOrmCommand(
  commandName: string,
  projects: DatabaseOrmProject[]
): Generator<DatabaseOrmProject, void, unknown> {
  const ormProjectByProject = new Map(projects.map((project) => [project.project, project]));
  for (const project of prepareForRunningCommand(
    commandName,
    projects.map(({ project }) => project)
  )) {
    const ormProject = ormProjectByProject.get(project);
    if (!ormProject) throw new Error(`Failed to detect database ORM for ${project.name}.`);

    yield ormProject;
  }
}

/**
 * Extract unknown options from argv to pass to ORM commands.
 */
export function extractUnknownOptions(argv: Record<string, unknown>, knownOptions: string[] = []): string {
  const unknownOptions: string[] = [];

  // Build list of known options from shared options builders
  const sharedOptionKeys = Object.keys(sharedOptionsBuilder);
  const sharedOptionAliases = Object.values(sharedOptionsBuilder)
    .flatMap((option) => {
      if ('alias' in option) {
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
    '--',
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

  const passthroughArgs = Array.isArray(argv['--']) ? argv['--'].map(String) : [];
  return buildShellCommand([...unknownOptions, ...passthroughArgs]);
}
