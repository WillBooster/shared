import child_process from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import chalk from 'chalk';
import type { PackageJson } from 'type-fest';
import type { CommandModule, InferredOptionTypes } from 'yargs';

import { findDescendantProjects } from '../project.js';
import { packageManager } from '../utils/runtime.js';

import { prepareForRunningCommand } from './commandUtils.js';

// These tools are declared as devDependencies in source repos, but optimized Docker
// package.json files still need them for in-image codegen/build steps.
const runtimeDevDependencies = ['@willbooster/wb', 'build-ts'];

const builder = {
  outside: {
    description: 'Whether the optimization is executed outside a docker container or not',
    type: 'boolean',
    alias: 'o',
  },
} as const;

export const optimizeForDockerBuildCommand: CommandModule<unknown, InferredOptionTypes<typeof builder>> = {
  command: 'optimizeForDockerBuild',
  describe: 'Optimize configuration when building a Docker image',
  builder,
  async handler(argv) {
    const projects = await findDescendantProjects(argv);
    if (!projects) {
      console.error(chalk.red('No project found.'));
      process.exit(1);
    }

    for (const project of prepareForRunningCommand('optimizeForDockerBuild', projects.descendants)) {
      const packageJson: PackageJson = project.packageJson;
      const keys = ['dependencies', 'devDependencies'] as const;
      for (const key of keys) {
        const deps = packageJson[key] ?? {};
        for (const [name, value] of Object.entries(deps)) {
          if (value?.startsWith('git@github.com:')) {
            // Docker builds cannot access private SSH URLs unless credentials are forwarded.
            // The Dockerfile copies those workspace packages into the image instead.
            deps[name] = `./${name}`;
          }
        }
      }

      optimizeDevDependencies(argv, packageJson);

      optimizeScripts(packageJson);

      optimizeRootProps(packageJson);

      if (argv.dryRun) continue;

      const distDirPath = argv.outside ? path.join(project.dirPath, 'dist') : project.dirPath;
      await fs.promises.mkdir(distDirPath, { recursive: true });
      await fs.promises.writeFile(path.join(distDirPath, 'package.json'), JSON.stringify(packageJson), 'utf8');
      if (argv.outside) {
        await writeDockerShellScripts(path.join(distDirPath, 'bash'));
      }
    }
    if (!argv.dryRun && !argv.outside) {
      child_process.spawnSync(packageManager, ['install'], {
        stdio: 'inherit',
      });
      console.info('Installed dependencies.');
    }
  },
};

async function writeDockerShellScripts(dirPath: string): Promise<void> {
  const sourceDirPath = findDockerShellScriptsDirPath();
  await fs.promises.mkdir(dirPath, { recursive: true });
  for (const dirent of await fs.promises.readdir(sourceDirPath, { withFileTypes: true })) {
    if (!dirent.isFile() || !dirent.name.endsWith('.sh')) continue;

    const targetFilePath = path.join(dirPath, dirent.name);
    await fs.promises.copyFile(path.join(sourceDirPath, dirent.name), targetFilePath);
    await fs.promises.chmod(targetFilePath, 0o755);
  }
  console.info(`Generated Docker shell scripts: ${path.relative(process.cwd(), dirPath) || dirPath}`);
}

function findDockerShellScriptsDirPath(): string {
  let currentDirPath = path.dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const candidate = path.join(currentDirPath, 'docker', 'bash');
    if (fs.existsSync(candidate)) return candidate;

    const parentDirPath = path.dirname(currentDirPath);
    if (parentDirPath === currentDirPath) {
      throw new Error('Docker shell scripts directory not found.');
    }
    currentDirPath = parentDirPath;
  }
}

function optimizeDevDependencies(argv: InferredOptionTypes<typeof builder>, packageJson: PackageJson): void {
  promoteRuntimeDevDependencies(packageJson);
  if (argv.outside) {
    // Outside optimization writes dist/package.json before Docker builds the app.
    // Keep build-time packages for that later in-image build and remove only known non-build tooling.
    removeUnnecessaryDevDependenciesForOutsideDockerBuild(packageJson);
    return;
  }

  // Inside Docker, codegen/build has already finished, so production install should not see dev tooling.
  delete packageJson.devDependencies;
  console.info('Removed all devDependencies.');
}

function removeUnnecessaryDevDependenciesForOutsideDockerBuild(packageJson: PackageJson): void {
  const devDeps = packageJson.devDependencies ?? {};
  // In --outside mode, Docker still runs codegen/build before a second in-image optimization.
  // Remove only tooling that is not needed for that build phase.
  const nameWordsToBeRemoved = [
    'artillery',
    'concurrently',
    'conventional-changelog-conventionalcommits',
    'husky',
    'imagemin',
    'jest',
    'kill-port',
    'lint-staged',
    'open-cli',
    'playwright',
    'prettier',
    'pinst',
    'railway',
    'semantic-release',
    'sort-package-json',
    'wait-on',
    'vitest',
  ];
  const removedDeps: string[] = [];
  for (const name of Object.keys(devDeps)) {
    if (
      nameWordsToBeRemoved.some((word) => name.includes(word)) ||
      // Shared config packages are needed only for lint/format/test commands, not Docker builds.
      (name.includes('willbooster') && name.includes('config'))
    ) {
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      delete devDeps[name];
      removedDeps.push(name);
    }
  }
  console.info('Removed devDependencies:', removedDeps.join(', ') || 'none');
}

function promoteRuntimeDevDependencies(packageJson: PackageJson): void {
  const devDeps = packageJson.devDependencies ?? {};
  const dependencies = packageJson.dependencies ?? {};
  const promotedDeps: string[] = [];
  for (const name of runtimeDevDependencies) {
    const version = devDeps[name];
    if (!version) continue;
    if (!dependencies[name]) {
      dependencies[name] = version;
      promotedDeps.push(name);
    }
    delete devDeps[name];
  }
  if (promotedDeps.length > 0) {
    packageJson.dependencies = dependencies;
  }
  console.info('Promoted runtime devDependencies:', promotedDeps.join(', ') || 'none');
}

function optimizeScripts(packageJson: PackageJson): void {
  const nameWordsOfUnnecessaryScripts = ['check', 'deploy', 'format', 'lint', 'start', 'test'];
  const contentWordsOfUnnecessaryScripts = ['pinst ', 'husky '];
  const scripts = (packageJson.scripts ?? {}) as Record<string, string>;
  const removedScripts: string[] = [];
  for (const [name, content] of Object.entries(scripts)) {
    if (
      nameWordsOfUnnecessaryScripts.some((word) => name.startsWith(word)) ||
      // Support "husky" since husky v9 requires `"postinstall": "husky"`
      contentWordsOfUnnecessaryScripts.some((word) => content.includes(word) || content.trim() === word.trim())
    ) {
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      delete scripts[name];
      removedScripts.push(name);
    }
  }
  console.info('Removed scripts:', removedScripts.join(', ') || 'none');
}

function optimizeRootProps(packageJson: PackageJson): void {
  delete packageJson.private;
  delete packageJson.publishConfig;
  delete packageJson.prettier;
}
