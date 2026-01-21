import fs from 'node:fs';
import path from 'node:path';

import chalk from 'chalk';
import type { ArgumentsCamelCase, CommandModule, InferredOptionTypes } from 'yargs';

import { findDescendantProjects } from '../project.js';
import { toDevNull } from '../scripts/builder.js';
import { dockerScripts } from '../scripts/dockerScripts.js';
import type { BaseScripts } from '../scripts/execution/baseScripts.js';
import { blitzScripts } from '../scripts/execution/blitzScripts.js';
import { httpServerScripts } from '../scripts/execution/httpServerScripts.js';
import { nextScripts } from '../scripts/execution/nextScripts.js';
import { plainAppScripts } from '../scripts/execution/plainAppScripts.js';
import { remixScripts } from '../scripts/execution/remixScripts.js';
import { viteScripts } from '../scripts/execution/viteScripts.js';
import { runWithSpawn, runWithSpawnInParallel } from '../scripts/run.js';
import type { sharedOptionsBuilder } from '../sharedOptionsBuilder.js';
import { promisePool } from '../utils/promisePool.js';

import { httpServerPackages } from './httpServerPackages.js';

const testOnCiBuilder = {
  silent: {
    description: 'Reduce redundant outputs',
    type: 'boolean',
  },
} as const;
export const testOnCiCommand: CommandModule<
  unknown,
  InferredOptionTypes<typeof testOnCiBuilder & typeof sharedOptionsBuilder>
> = {
  command: 'test-on-ci',
  describe: 'Test project on CI with no options.',
  builder: testOnCiBuilder,
  async handler(argv) {
    await testOnCi(argv);
  },
};

export async function testOnCi(
  argv: ArgumentsCamelCase<InferredOptionTypes<typeof testOnCiBuilder & typeof sharedOptionsBuilder>>
): Promise<void> {
  const projects = await findDescendantProjects(argv);
  if (!projects) {
    console.error(chalk.red('No project found.'));
    process.exit(1);
  }

  process.env.CI ||= '1';
  process.env.FORCE_COLOR ||= '3';
  process.env.WB_ENV ||= 'test';

  for (const project of projects.descendants) {
    const deps = project.packageJson.dependencies ?? {};
    const devDeps = project.packageJson.devDependencies ?? {};
    let scripts: BaseScripts;
    if (deps.blitz) {
      scripts = blitzScripts;
    } else if (deps.next) {
      scripts = nextScripts;
    } else if (devDeps['@remix-run/dev']) {
      scripts = remixScripts;
    } else if (devDeps.vite) {
      scripts = viteScripts;
    } else if (httpServerPackages.some((p) => deps[p]) && !deps['firebase-functions']) {
      scripts = httpServerScripts;
    } else {
      scripts = plainAppScripts;
    }

    console.info(`Running "test-on-ci" for ${project.name} ...`);

    await runWithSpawnInParallel(dockerScripts.stopAll(), project, argv);
    if (fs.existsSync(path.join(project.dirPath, 'test', 'unit'))) {
      // CI mode disallows `only` to avoid including debug tests
      await runWithSpawnInParallel(scripts.testUnit(project, argv).replaceAll(' --allowOnly', ''), project, argv);
    }
    if (fs.existsSync(path.join(project.dirPath, 'test', 'e2e'))) {
      // Avoid launching dev servers for build-only packages; only start a server when E2E needs it.
      await runWithSpawnInParallel(await scripts.testStart(project, argv), project, argv);
      await promisePool.promiseAll();
      if (project.hasDockerfile) {
        project.env.WB_DOCKER ||= '1';
        await runWithSpawn(`${scripts.buildDocker(project, 'test')}${toDevNull(argv)}`, project, argv);
      }
      const script = project.hasDockerfile
        ? await scripts.testE2EDocker(project, argv, {})
        : await scripts.testE2EProduction(project, argv, {});
      process.exitCode = await runWithSpawn(
        // CI mode disallows `only` to avoid including debug tests
        script.replaceAll(' --allowOnly', ''),
        project,
        argv,
        {
          exitIfFailed: false,
        }
      );
      await runWithSpawn(dockerScripts.stop(project), project, argv);
    }
  }
}
