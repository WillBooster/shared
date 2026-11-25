import fs from 'node:fs';
import path from 'node:path';

import chalk from 'chalk';
import type { CommandModule } from 'yargs';

import type { Project } from '../project.js';
import { findDescendantProjects } from '../project.js';
import { findDrizzleConfig, wrapWithDrizzleConfigDir } from '../scripts/drizzleScripts.js';
import { prismaScripts } from '../scripts/prismaScripts.js';
import { runWithSpawn } from '../scripts/run.js';
import { normalizeBunLockfile } from '../utils/bunLockfile.js';
import { buildCfCommand } from '../utils/cloudflare.js';

const builder = {} as const;

const blitzRouteManifestStubByFileName = {
  'index-browser.js': 'exports.Routes = {};\n',
  'index.d.ts': 'export declare const Routes: Record<string, never>;\n',
  'index.js': 'exports.Routes = {};\n',
};

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

    // Before the early return below: `gen-code` is the `postinstall` script wbfy generates, making
    // this the first wb code that runs after bun may have rewritten the lockfile, and a repository
    // with nothing to generate needs the normalization just as much. `rootDirPath` rather than
    // `projects.root.dirPath`: bun runs a workspace package's postinstall from that package's
    // directory, and findRootAndSelfProjects only climbs out of `packages/*`, so a workspace such
    // as `apps/web` would otherwise look for `apps/web/bun.lock` instead of the repository's.
    if (!argv.dryRun) {
      normalizeBunLockfile(projects.self.rootDirPath);
      for (const project of projects.descendants) {
        writeBlitzRouteManifestStub(project);
      }
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

/**
 * `@blitzjs/next` unconditionally loads the route manifest `.blitz`, which only the blitz CLI
 * generates and Bun-managed repositories never run (see getGenCodeScripts). Their apps
 * hand-maintain their routes instead of using the generated `Routes`, so an empty manifest
 * satisfies the import. It goes into the workspace root's node_modules: the isolated linker keeps
 * the real @blitzjs/next under `<root>/node_modules/.bun`, and module resolution walks up from
 * there, never through a workspace package's own node_modules.
 */
function writeBlitzRouteManifestStub(project: Project): void {
  if (!project.usesBunPackageManager || !project.hasOwnDependency('@blitzjs/next')) return;

  const dirPath = path.join(project.rootDirPath, 'node_modules', '.blitz');
  fs.mkdirSync(dirPath, { recursive: true });
  for (const [fileName, content] of Object.entries(blitzRouteManifestStubByFileName)) {
    const filePath = path.join(dirPath, fileName);
    if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, content);
  }
}

export function getGenCodeScripts(project: Project): string[] {
  const scripts: string[] = [];
  // First: the generated types are gitignored, so on a fresh checkout they do not exist yet,
  // and the generators below type-check against the Cloudflare `Env` they declare.
  if (project.generatesWorkerTypes) {
    // `YARN cf` rather than `bunx cf`: cf needs real Node.js, and `bunx` may resolve a version
    // other than the lockfile's. `< /dev/null`: gen-code runs as `postinstall` inside git hooks,
    // where nobody could answer a prompt.
    scripts.push(`${buildCfCommand(project, 'workers types')} < /dev/null`);
  }
  // Yarn-era Blitz repositories need `blitz codegen` for the route manifest (node_modules/.blitz)
  // that @blitzjs/next's type declarations re-export; install scripts do not run it
  // (enableScripts: false). Never under Bun: the blitz CLI patches the installed next package in
  // place, which Bun-era Blitz repositories must avoid (they get an empty manifest from
  // writeBlitzRouteManifestStub instead). On a fresh install `blitz codegen` also
  // generates the Prisma client itself, making the PRISMA generate step below redundant once —
  // keeping both is deliberate: after schema-only changes blitz's already-generated guard skips
  // its internal generate, so the explicit step is still what regenerates the client.
  if (!project.usesBunPackageManager && project.hasOwnDependency('blitz') && project.hasSourceCode) {
    scripts.push('YARN blitz codegen');
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
