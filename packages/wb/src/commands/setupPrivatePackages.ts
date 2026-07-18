import fs from 'node:fs';
import path from 'node:path';

import chalk from 'chalk';
import type { PackageJson } from 'type-fest';
import type { CommandModule, InferredOptionTypes } from 'yargs';

import { findRootAndSelfProjects } from '../project.js';
import {
  PRIVATE_REGISTRY_SCOPE,
  downloadAndExtractRegistryPackage,
  isPrivateRegistryDependency,
  resolvePrivateRegistryAuth,
} from '../utils/privateRegistry.js';

interface PrivatePackage {
  name: string;
  kind: 'git' | 'registry';
  /** Undefined for registry packages, which are downloaded instead of copied. */
  sourceDirPath: string | undefined;
  targetDirPath: string;
  versionSpecifier: string | undefined;
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
  describe:
    'Materialize private dependencies for Docker builds: copy git dependencies and download @willbooster-private/* registry packages (auth via .npmrc / ~/.npmrc locally, or VERDACCIO_TOKEN on CI)',
  builder,
  async handler(argv) {
    const projects = findRootAndSelfProjects(argv, false);
    if (!projects) {
      console.error(chalk.red('No project found.'));
      process.exit(1);
    }

    const outDirPath = path.resolve(projects.root.dirPath, argv.outDir);
    assertSubdirectory(projects.root.dirPath, outDirPath);
    const registryOutDirPath = path.join(path.dirname(outDirPath), PRIVATE_REGISTRY_SCOPE);
    assertSubdirectory(projects.root.dirPath, registryOutDirPath);
    const privatePackages = await collectPrivatePackages(
      projects.root.dirPath,
      projects.root.packageJson,
      outDirPath,
      registryOutDirPath
    );

    if (argv.dryRun) {
      printDryRunResult(outDirPath, privatePackages);
      return;
    }

    const copiedPackages = [...privatePackages.values()].filter((p) => p.kind === 'git');
    const registryPackages = [...privatePackages.values()].filter((p) => p.kind === 'registry');
    await fs.promises.rm(outDirPath, { recursive: true, force: true });
    if (copiedPackages.length > 0) {
      await fs.promises.mkdir(outDirPath, { recursive: true });
    }
    for (const privatePackage of copiedPackages) {
      await fs.promises.cp(privatePackage.sourceDirPath!, privatePackage.targetDirPath, {
        recursive: true,
        force: true,
        filter: (src) => {
          const segments = path.relative(privatePackage.sourceDirPath!, src).split(path.sep);
          return !segments.includes('node_modules') && !segments.includes('.git');
        },
      });
      console.info(
        `Copied ${privatePackage.name} to ${path.relative(projects.root.dirPath, privatePackage.targetDirPath)}`
      );
    }

    await fs.promises.rm(registryOutDirPath, { recursive: true, force: true });
    if (registryPackages.length > 0) {
      const auth = resolvePrivateRegistryAuth(projects.root.dirPath);
      if (!auth) {
        console.error(
          chalk.red(
            `No registry configured for the ${PRIVATE_REGISTRY_SCOPE} scope; add "${PRIVATE_REGISTRY_SCOPE}:registry=..." to .npmrc or ~/.npmrc.`
          )
        );
        process.exit(1);
      }
      for (const privatePackage of registryPackages) {
        await downloadAndExtractRegistryPackage(
          auth,
          privatePackage.name,
          privatePackage.versionSpecifier ?? 'latest',
          privatePackage.targetDirPath
        );
        console.info(
          `Downloaded ${privatePackage.name} to ${path.relative(projects.root.dirPath, privatePackage.targetDirPath)}`
        );
        // A downloaded package may itself depend on private packages that were not visible before
        // extraction; materialize them too.
        await collectNestedPrivatePackages(privatePackage, privatePackages, outDirPath, registryOutDirPath);
      }
    }

    await replacePrivateDependencies(projects.root.dirPath, privatePackages);
  },
};

async function collectPrivatePackages(
  rootDirPath: string,
  rootPackageJson: PackageJson,
  outDirPath: string,
  registryOutDirPath: string
): Promise<Map<string, PrivatePackage>> {
  const privatePackages = new Map<string, PrivatePackage>();
  // Start from the root package.json by design; workspace package dependencies are outside this command's target.
  const packagesToProcess = findPrivateDependencies(rootPackageJson, outDirPath, registryOutDirPath);
  const queuedPackageNames = new Set(packagesToProcess.map((p) => p.name));

  for (let index = 0; index < packagesToProcess.length; index++) {
    const privatePackage = packagesToProcess[index];
    if (!privatePackage) continue;
    if (privatePackages.has(privatePackage.name)) continue;

    if (privatePackage.kind === 'git') {
      privatePackage.sourceDirPath = findInstalledPackageDir(rootDirPath, privatePackage.name);
      // Nested private dependencies of an installed git package are discoverable right away;
      // registry packages are inspected after download instead (collectNestedPrivatePackages).
      for (const packageJsonPath of await findPackageJsonPaths(privatePackage.sourceDirPath)) {
        const packageJson = await readPackageJson(packageJsonPath);
        for (const nested of findPrivateDependencies(packageJson, outDirPath, registryOutDirPath)) {
          if (!queuedPackageNames.has(nested.name)) {
            queuedPackageNames.add(nested.name);
            packagesToProcess.push(nested);
          }
        }
      }
    }
    privatePackages.set(privatePackage.name, privatePackage);
  }

  return privatePackages;
}

async function collectNestedPrivatePackages(
  extractedPackage: PrivatePackage,
  privatePackages: Map<string, PrivatePackage>,
  outDirPath: string,
  registryOutDirPath: string
): Promise<void> {
  const packageJsonPath = path.join(extractedPackage.targetDirPath, 'package.json');
  if (!fs.existsSync(packageJsonPath)) return;

  for (const nested of findPrivateDependencies(
    await readPackageJson(packageJsonPath),
    outDirPath,
    registryOutDirPath
  )) {
    if (privatePackages.has(nested.name) || nested.kind !== 'registry') continue;

    const auth = resolvePrivateRegistryAuth(path.dirname(registryOutDirPath));
    if (!auth) continue;
    await downloadAndExtractRegistryPackage(
      auth,
      nested.name,
      nested.versionSpecifier ?? 'latest',
      nested.targetDirPath
    );
    console.info(`Downloaded ${nested.name} (nested dependency) to ${nested.targetDirPath}`);
    privatePackages.set(nested.name, nested);
    await collectNestedPrivatePackages(nested, privatePackages, outDirPath, registryOutDirPath);
  }
}

function assertSubdirectory(rootDirPath: string, outDirPath: string): void {
  const relativePath = path.relative(rootDirPath, outDirPath);
  if (relativePath && !relativePath.startsWith('..') && !path.isAbsolute(relativePath)) return;

  console.error(chalk.red(`Output directory must be a subdirectory of the project root: ${outDirPath}`));
  process.exit(1);
}

function findInstalledPackageDir(rootDirPath: string, packageName: string): string {
  const sourceDirPath = path.join(rootDirPath, 'node_modules', '@willbooster', toUnscopedPackageName(packageName));
  if (!fs.existsSync(path.join(sourceDirPath, 'package.json'))) {
    throw new Error(`Private package is not installed: ${packageName} (${sourceDirPath})`);
  }
  return sourceDirPath;
}

function findPrivateDependencies(
  packageJson: PackageJson,
  outDirPath: string,
  registryOutDirPath: string
): PrivatePackage[] {
  const privatePackages = new Map<string, PrivatePackage>();
  for (const key of dependencyKeys) {
    const dependencies = packageJson[key];
    if (!dependencies) continue;

    for (const [name, value] of Object.entries(dependencies)) {
      if (isPrivateGitDependency(value)) {
        if (!name.startsWith('@willbooster/')) {
          throw new Error(`Private git dependency must be an @willbooster package: ${name}`);
        }
        privatePackages.set(name, {
          name,
          kind: 'git',
          sourceDirPath: undefined,
          targetDirPath: path.join(outDirPath, toUnscopedPackageName(name)),
          versionSpecifier: undefined,
        });
      } else if (isPrivateRegistryDependency(name, value)) {
        privatePackages.set(name, {
          name,
          kind: 'registry',
          sourceDirPath: undefined,
          targetDirPath: path.join(registryOutDirPath, toUnscopedPackageName(name)),
          versionSpecifier: value,
        });
      }
    }
  }
  return [...privatePackages.values()];
}

async function replacePrivateDependencies(
  rootDirPath: string,
  privatePackages: Map<string, PrivatePackage>
): Promise<void> {
  for (const privatePackage of privatePackages.values()) {
    for (const packageJsonPath of await findPackageJsonPaths(privatePackage.targetDirPath)) {
      const packageJson = await readPackageJson(packageJsonPath);
      if (!replacePackageJsonDependencies(packageJsonPath, packageJson, privatePackages)) continue;

      await fs.promises.writeFile(packageJsonPath, `${JSON.stringify(packageJson, undefined, 2)}\n`, 'utf8');
      console.info(`Rewrote private dependencies in ${path.relative(rootDirPath, packageJsonPath)}`);
    }
  }
}

function replacePackageJsonDependencies(
  packageJsonPath: string,
  packageJson: PackageJson,
  privatePackages: Map<string, PrivatePackage>
): boolean {
  let changed = false;
  for (const key of dependencyKeys) {
    const dependencies = packageJson[key];
    if (!dependencies) continue;

    for (const [name, value] of Object.entries(dependencies)) {
      if (!isPrivateGitDependency(value) && !isPrivateRegistryDependency(name, value)) continue;
      const targetPackage = privatePackages.get(name);
      if (!targetPackage) continue;

      dependencies[name] = `file:${path.relative(path.dirname(packageJsonPath), targetPackage.targetDirPath)}`;
      changed = true;
    }
  }
  return changed;
}

async function findPackageJsonPaths(dirPath: string): Promise<string[]> {
  if (!fs.existsSync(dirPath)) return [];

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
  return packageName.replace(/^@willbooster(?:-private)?\//, '');
}

function printDryRunResult(outDirPath: string, privatePackages: Map<string, PrivatePackage>): void {
  console.info(`[dry-run] Would recreate ${outDirPath}`);
  for (const privatePackage of privatePackages.values()) {
    console.info(
      privatePackage.kind === 'git'
        ? `[dry-run] Would copy ${privatePackage.name}: ${privatePackage.sourceDirPath ?? '(installed under node_modules)'}`
        : `[dry-run] Would download ${privatePackage.name}@${privatePackage.versionSpecifier} to ${privatePackage.targetDirPath}`
    );
  }
  console.info(`[dry-run] Would rewrite copied private dependencies to file:../<name>`);
}
