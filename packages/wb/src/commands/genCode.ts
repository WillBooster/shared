import fs from 'node:fs';
import path from 'node:path';

import chalk from 'chalk';
import type { CommandModule } from 'yargs';

import type { Project } from '../project.js';
import { findDescendantProjects } from '../project.js';
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

function getGenCodeScripts(project: Project): string[] {
  const scripts: string[] = [];
  if (project.hasOwnDependency('blitz')) {
    scripts.push('YARN blitz codegen');
    if (project.hasPrisma) {
      scripts.push('YARN blitz prisma generate');
    }
  } else if (project.hasPrisma) {
    scripts.push('PRISMA generate');
  }

  const chakraTypegenScript = getChakraScript(project);
  if (chakraTypegenScript) {
    scripts.push(chakraTypegenScript);
  }

  scripts.push(...getDrizzleOnlyCompatibilityScripts(project, scripts));
  return scripts;
}

function getChakraScript(project: Project): string | undefined {
  if (!project.hasOwnDependency('@chakra-ui/cli')) return;

  const coreThemePath = 'src/core/theme.ts';
  if (getDependencyMajor(project, '@chakra-ui/cli') === 2 && fileExists(project, coreThemePath)) {
    return `YARN chakra-cli tokens ${coreThemePath}`;
  }
  const themePath = 'src/theme.ts';
  if (fileExists(project, themePath)) {
    return `YARN chakra typegen ${themePath} --strict`;
  }
  if (fileExists(project, coreThemePath)) {
    return `YARN chakra-cli tokens ${coreThemePath}`;
  }
  return;
}

function getDrizzleOnlyCompatibilityScripts(project: Project, alreadyGeneratedScripts: string[]): string[] {
  if (alreadyGeneratedScripts.length > 0 || !project.hasDrizzle) return [];

  const drizzleConfigPath = getDrizzleConfigPath(project);
  return drizzleConfigPath ? [`YARN drizzle-kit check --config ${drizzleConfigPath} || true`] : [];
}

function getDrizzleConfigPath(project: Project): string | undefined {
  const candidates = ['drizzle.config.ts', 'drizzle.config.mts', 'drizzle.config.js', 'drizzle.config.mjs'];
  return candidates.find((filePath) => fileExists(project, filePath));
}

function getDependencyMajor(project: Project, packageName: string): number | undefined {
  const version = getOwnDependencyVersion(project, packageName);
  const major = version?.match(/\d+/u)?.[0];
  return major === undefined ? undefined : Number(major);
}

function getOwnDependencyVersion(project: Project, packageName: string): string | undefined {
  const packageJson = project.packageJson;
  return (
    packageJson.dependencies?.[packageName] ??
    packageJson.devDependencies?.[packageName] ??
    packageJson.optionalDependencies?.[packageName] ??
    packageJson.peerDependencies?.[packageName]
  );
}

function fileExists(project: Project, filePath: string): boolean {
  return fs.existsSync(path.join(project.dirPath, filePath));
}
