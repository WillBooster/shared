import fs from 'node:fs';
import path from 'node:path';

import chalk from 'chalk';
import type { CommandModule } from 'yargs';

import type { Project } from '../project.js';
import { findDescendantProjects } from '../project.js';
import { prismaScripts } from '../scripts/prismaScripts.js';
import { runWithSpawn } from '../scripts/run.js';

const builder = {} as const;

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
      for (const script of scripts) {
        await runWithSpawn(script, project, argv);
      }
    }
  },
};

export function getGenCodeScripts(project: Project): string[] {
  const scripts: string[] = [];
  if (project.hasOwnDependency('blitz')) {
    scripts.push('YARN blitz codegen');
    if (project.hasPrisma) {
      scripts.push(prismaScripts.generate(project));
    }
  } else if (project.hasPrisma) {
    scripts.push(prismaScripts.generate(project));
  }

  const chakraTypegenScript = getChakraScript(project);
  if (chakraTypegenScript) {
    scripts.push(chakraTypegenScript);
  }

  const drizzleConfigPath = scripts.length === 0 && project.hasDrizzle ? getDrizzleConfigPath(project) : undefined;
  if (drizzleConfigPath) {
    scripts.push(`YARN drizzle-kit check --config ${drizzleConfigPath} || true`);
  }
  if (project.hasOwnDependency('gen-i18n-ts') && project.packageJson.scripts?.['gen-i18n-ts']) {
    scripts.push('YARN run gen-i18n-ts');
  }
  return scripts;
}

function getChakraScript(project: Project): string | undefined {
  if (!project.hasOwnDependency('@chakra-ui/cli')) return;

  if (getOwnDependencyMajor(project, '@chakra-ui/cli') === 2) {
    return 'YARN chakra-cli tokens src/core/theme.ts';
  }
  if (fileExists(project, 'src/theme.ts')) {
    return 'YARN chakra typegen src/theme.ts --strict';
  }
  return;
}

function getDrizzleConfigPath(project: Project): string | undefined {
  const candidates = ['drizzle.config.ts', 'drizzle.config.mts', 'drizzle.config.js', 'drizzle.config.mjs'];
  return candidates.find((filePath) => fileExists(project, filePath));
}

function getOwnDependencyMajor(project: Project, packageName: string): number | undefined {
  const packageJson = project.packageJson;
  const version =
    packageJson.dependencies?.[packageName] ??
    packageJson.devDependencies?.[packageName] ??
    packageJson.optionalDependencies?.[packageName] ??
    packageJson.peerDependencies?.[packageName];
  const major = version?.match(/\d+/u)?.[0];
  return major === undefined ? undefined : Number(major);
}

function fileExists(project: Project, filePath: string): boolean {
  return fs.existsSync(path.join(project.dirPath, filePath));
}
