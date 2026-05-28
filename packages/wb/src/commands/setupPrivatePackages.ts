import fs from 'node:fs';
import path from 'node:path';

import chalk from 'chalk';
import type { PackageJson } from 'type-fest';
import type { CommandModule, InferredOptionTypes } from 'yargs';

import { findRootAndSelfProjects } from '../project.js';

interface PrivatePackage {
  name: string;
  sourceDirPath: string;
  targetDirPath: string;
}

const dependencyKeys = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'] as const;
const privateGitDependencyPattern = /^git@github\.com:(?:WillBooster|WillBoosterLab)\/[^/#]+(?:\.git)?(?:#.*)?$/;

const builder = {
  'out-dir': {
    description: 'Directory to copy private packages into',
    type: 'string',
    default: '@willbooster',
  },
} as const;

export const setupPrivatePackagesCommand: CommandModule<{ dryRun?: boolean }, InferredOptionTypes<typeof builder>> = {
  command: 'setup-private-packages',
  describe: 'Copy private git dependencies for Docker builds',
  builder,
  async handler(argv) {
    const projects = findRootAndSelfProjects(argv, false);
    if (!projects) {
      console.error(chalk.red('No project found.'));
      process.exit(1);
    }

    const outDirPath = path.resolve(projects.root.dirPath, argv.outDir);
    const copiedPackages = await collectPrivatePackages(projects.root.dirPath, projects.root.packageJson, outDirPath);

    if (argv.dryRun) {
      printDryRunResult(outDirPath, copiedPackages);
      return;
    }

    await fs.promises.rm(outDirPath, { recursive: true, force: true });
    await fs.promises.mkdir(outDirPath, { recursive: true });
    for (const privatePackage of copiedPackages.values()) {
      await fs.promises.cp(privatePackage.sourceDirPath, privatePackage.targetDirPath, {
        recursive: true,
        force: true,
        filter: (src) => {
          const segments = path.relative(privatePackage.sourceDirPath, src).split(path.sep);
          return !segments.includes('node_modules') && !segments.includes('.git');
        },
      });
      console.info(
        `Copied ${privatePackage.name} to ${path.relative(projects.root.dirPath, privatePackage.targetDirPath)}`
      );
    }

    await replacePrivateGitDependencies(outDirPath, copiedPackages);
  },
};

async function collectPrivatePackages(
  rootDirPath: string,
  rootPackageJson: PackageJson,
  outDirPath: string
): Promise<Map<string, PrivatePackage>> {
  const copiedPackages = new Map<string, PrivatePackage>();
  // Start from the root package.json by design; workspace package dependencies are outside this command's target.
  const packageNamesToCopy = findPrivateGitDependencyNames(rootPackageJson);

  for (let index = 0; index < packageNamesToCopy.length; index++) {
    const packageName = packageNamesToCopy[index];
    if (!packageName) continue;
    if (copiedPackages.has(packageName)) continue;

    const privatePackage = buildPrivatePackage(rootDirPath, outDirPath, packageName);
    copiedPackages.set(packageName, privatePackage);

    for (const packageJsonPath of await findPackageJsonPaths(privatePackage.sourceDirPath)) {
      const packageJson = await readPackageJson(packageJsonPath);
      for (const nestedPackageName of findPrivateGitDependencyNames(packageJson)) {
        if (!copiedPackages.has(nestedPackageName) && !packageNamesToCopy.includes(nestedPackageName)) {
          packageNamesToCopy.push(nestedPackageName);
        }
      }
    }
  }

  return copiedPackages;
}

function buildPrivatePackage(rootDirPath: string, outDirPath: string, packageName: string): PrivatePackage {
  const unscopedPackageName = toUnscopedPackageName(packageName);
  const sourceDirPath = path.join(rootDirPath, 'node_modules', '@willbooster', unscopedPackageName);
  if (!fs.existsSync(path.join(sourceDirPath, 'package.json'))) {
    throw new Error(`Private package is not installed: ${packageName} (${sourceDirPath})`);
  }

  return {
    name: packageName,
    sourceDirPath,
    targetDirPath: path.join(outDirPath, unscopedPackageName),
  };
}

function findPrivateGitDependencyNames(packageJson: PackageJson): string[] {
  const packageNames: string[] = [];
  for (const key of dependencyKeys) {
    const dependencies = packageJson[key];
    if (!dependencies) continue;

    for (const [name, value] of Object.entries(dependencies)) {
      if (!isPrivateGitDependency(value)) continue;

      if (!name.startsWith('@willbooster/')) {
        throw new Error(`Private git dependency must be an @willbooster package: ${name}`);
      }
      packageNames.push(name);
    }
  }
  return [...new Set(packageNames)];
}

async function replacePrivateGitDependencies(
  outDirPath: string,
  copiedPackages: Map<string, PrivatePackage>
): Promise<void> {
  for (const privatePackage of copiedPackages.values()) {
    for (const packageJsonPath of await findPackageJsonPaths(privatePackage.targetDirPath)) {
      const packageJson = await readPackageJson(packageJsonPath);
      if (!replacePackageJsonDependencies(packageJsonPath, packageJson, copiedPackages)) continue;

      await fs.promises.writeFile(packageJsonPath, `${JSON.stringify(packageJson, undefined, 2)}\n`, 'utf8');
      console.info(`Rewrote private dependencies in ${path.relative(outDirPath, packageJsonPath)}`);
    }
  }
}

function replacePackageJsonDependencies(
  packageJsonPath: string,
  packageJson: PackageJson,
  copiedPackages: Map<string, PrivatePackage>
): boolean {
  let changed = false;
  for (const key of dependencyKeys) {
    const dependencies = packageJson[key];
    if (!dependencies) continue;

    for (const [name, value] of Object.entries(dependencies)) {
      if (!isPrivateGitDependency(value)) continue;
      const targetPackage = copiedPackages.get(name);
      if (!targetPackage) continue;

      dependencies[name] = `file:${path.relative(path.dirname(packageJsonPath), targetPackage.targetDirPath)}`;
      changed = true;
    }
  }
  return changed;
}

async function findPackageJsonPaths(dirPath: string): Promise<string[]> {
  const packageJsonPaths: string[] = [];
  for (const dirent of await fs.promises.readdir(dirPath, { withFileTypes: true })) {
    if (dirent.name === 'node_modules' || dirent.name === '.git') continue;

    const childPath = path.join(dirPath, dirent.name);
    if (dirent.isDirectory()) {
      packageJsonPaths.push(...(await findPackageJsonPaths(childPath)));
      continue;
    }
    if (dirent.isFile() && dirent.name === 'package.json') {
      packageJsonPaths.push(childPath);
    }
  }
  return packageJsonPaths;
}

async function readPackageJson(packageJsonPath: string): Promise<PackageJson> {
  return JSON.parse(await fs.promises.readFile(packageJsonPath, 'utf8')) as PackageJson;
}

function isPrivateGitDependency(value: unknown): value is string {
  return typeof value === 'string' && privateGitDependencyPattern.test(value);
}

function toUnscopedPackageName(packageName: string): string {
  return packageName.replace(/^@willbooster\//, '');
}

function printDryRunResult(outDirPath: string, copiedPackages: Map<string, PrivatePackage>): void {
  console.info(`[dry-run] Would recreate ${outDirPath}`);
  for (const privatePackage of copiedPackages.values()) {
    console.info(`[dry-run] Would copy ${privatePackage.name}: ${privatePackage.sourceDirPath}`);
  }
  console.info(`[dry-run] Would rewrite copied private git dependencies to file:../<name>`);
}
