import fs from 'node:fs';
import path from 'node:path';

import type { EnvReaderOptions } from '@willbooster/shared-lib-node/src';
import chalk from 'chalk';
import type { CommandModule } from 'yargs';

import type { Project } from '../project.js';
import { findDescendantProjects } from '../project.js';
import { findDrizzleConfig, wrapWithDrizzleConfigDir } from '../scripts/drizzleScripts.js';
import { prismaScripts } from '../scripts/prismaScripts.js';
import { runWithSpawn } from '../scripts/run.js';

import { writeEnvVarsFile } from './genDevVars.js';

const builder = {} as const;

// `wrangler types` derives the Cloudflare `Env`'s secret/var members only from the KEY NAMES in a
// .dev.vars/.env file (never from process.env), and `--env-file` REPLACES that default file set. So
// gen-code types a Worker against a throwaway key-only stub written here — see generateWorkerTypesEnvStub.
const workerTypesEnvPath = path.join('.wrangler', 'worker-types.env');

export const genCodeCommand: CommandModule = {
  command: 'gen-code',
  describe: 'Generate code for the current project',
  builder,
  async handler(argv) {
    const projects = await findDescendantProjects(argv);
    if (!projects) {
      console.error(chalk.red('No project found.'));
      process.exit(1);
    }

    const genCodeTargets = projects.descendants
      .map((project) => ({ project, scripts: getGenCodeScripts(project) }))
      .filter(({ scripts }) => scripts.length > 0);
    if (genCodeTargets.length === 0) {
      console.info(chalk.green('No code generation needed.'));
      return;
    }
    for (const { project, scripts } of genCodeTargets) {
      console.info(`Running "gen-code" for ${project.name} ...`);
      // Write the wrangler-types key stub the first script consumes, in THIS process rather than via a
      // nested `wb gen-dev-vars`: a child would re-resolve the cascade from its own (mode-file-modified)
      // environment and could type the wrong profile, whereas an in-process write inherits gen-code's
      // already-resolved environment.
      if (getWranglerTypesScript(project)) {
        generateWorkerTypesEnvStub(project, argv);
      }
      for (const script of scripts) {
        await runWithSpawn(script, project, argv);
      }
    }
  },
};

/**
 * Write the key-only stub that `wrangler types --env-file` reads. `autoCascadeEnv` is forced on so
 * the base `.env` is always part of the typed key set even when the caller disabled cascading —
 * matching the keys wrangler would otherwise read natively, which `--env-file` replaces.
 */
function generateWorkerTypesEnvStub(project: Project, argv: EnvReaderOptions & { dryRun?: boolean }): void {
  writeEnvVarsFile(
    project,
    { ...argv, autoCascadeEnv: true },
    { outputPath: path.resolve(project.dirPath, workerTypesEnvPath), forTypes: true }
  );
}

export function getGenCodeScripts(project: Project): string[] {
  const scripts: string[] = [];
  // First: `worker-configuration.d.ts` is gitignored, so on a fresh checkout it does not exist yet,
  // and the generators below type-check against the Cloudflare `Env` it declares.
  const wranglerTypesScript = getWranglerTypesScript(project);
  if (wranglerTypesScript) {
    // `--env-file` points wrangler at the key stub generateWorkerTypesEnvStub writes (from the
    // wb-managed environment variables), so a fresh checkout with no runtime .dev.vars (e.g. CI) still
    // types every secret. Without it a bare `wrangler types` yields an `Env` missing every secret and
    // the type-aware generators/linters below fail (e.g. "Property 'AUTH_SECRET' does not exist").
    scripts.push(`${wranglerTypesScript} --env-file ${workerTypesEnvPath}`);
  }
  const prismaGenerateScript = getPrismaGenerateScript(project);
  if (prismaGenerateScript) {
    scripts.push(prismaGenerateScript);
  }
  const chakraTypegenScript = getChakraScript(project);
  if (chakraTypegenScript) {
    scripts.push(chakraTypegenScript);
  }
  const drizzleCheckScript = getDrizzleCheckScript(project);
  if (drizzleCheckScript) {
    scripts.push(drizzleCheckScript);
  }
  const genI18nTsScript = getGenI18nTsScript(project);
  if (genI18nTsScript) {
    scripts.push(genI18nTsScript);
  }
  return scripts;
}

/**
 * `YARN wrangler` rather than `bunx wrangler`: wrangler needs real Node.js, and `bunx` may resolve
 * a version other than the lockfile's. Returns the base command; the caller appends `--env-file`
 * pointing at a generated key-only stub (see getGenCodeScripts) because fnox repositories have no
 * `.env` file for wrangler to infer the secret bindings from. `--strict-vars` is deliberately left
 * out — it is a per-repository type-strictness choice that belongs in the wrangler config.
 */
function getWranglerTypesScript(project: Project): string | undefined {
  if (!project.generatesWorkerTypes) return;
  return 'YARN wrangler types';
}

function getGenI18nTsScript(project: Project): string | undefined {
  if (project.packageJson.scripts?.['gen-i18n-ts']) {
    if (!project.hasSourceCode) return;
    return 'YARN run gen-i18n-ts';
  }
  if (
    project.hasOwnDependency('gen-i18n-ts') &&
    project.hasSourceCode &&
    fs.existsSync(path.join(project.dirPath, 'i18n'))
  ) {
    return 'YARN gen-i18n-ts -i i18n -o src/__generated__/i18n.ts -d ja-JP';
  }
  return;
}

function getPrismaGenerateScript(project: Project): string | undefined {
  if (!project.hasPrisma) return;
  if (!hasPrismaSchema(project)) return;
  return prismaScripts.generate(project);
}

function getChakraScript(project: Project): string | undefined {
  if (!project.hasOwnDependency('@chakra-ui/cli')) return;
  if (!fileExists(project, 'src/theme.ts')) return;
  return 'YARN chakra typegen src/theme.ts --strict';
}

function getDrizzleCheckScript(project: Project): string | undefined {
  if (!project.hasDrizzle) return;
  const config = findDrizzleConfig(project);
  if (!config) return;
  // Keep the explicit --config because drizzle-kit's default lookup misses some extensions (e.g. .mts).
  return `${wrapWithDrizzleConfigDir(project, `YARN drizzle-kit check --config ${config.fileName}`)} || true`;
}

function fileExists(project: Project, filePath: string): boolean {
  return fs.existsSync(path.join(project.dirPath, filePath));
}

function hasPrismaSchema(project: Project): boolean {
  return ['prisma/schema.prisma', 'prisma/schema', 'db/schema.prisma'].some((filePath) =>
    fileExists(project, filePath)
  );
}
