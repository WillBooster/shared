import fs from 'node:fs';
import path from 'node:path';

import { logger } from '../logger.js';
import type { PackageConfig } from '../packageConfig.js';
import { extensions } from '../utils/extensions.js';
import { fsUtil } from '../utils/fsUtil.js';
import { doesContainJava, doesContainJsOrTs } from '../utils/packageCapabilities.js';
import { promisePool } from '../utils/promisePool.js';

// Keep package-manager shims in the File Watcher program field so node does not
// parse wrapper scripts passed through arguments.
const oxfmtProgram = '$ProjectFileDir$/node_modules/.bin/oxfmt';
const prettierProgram = '$ProjectFileDir$/node_modules/.bin/prettier';

export async function generateIdeaSettings(config: PackageConfig): Promise<void> {
  return logger.functionIgnoringException('generateIdeaSettings', async () => {
    const dirPath = path.resolve(config.dirPath, '.idea');
    if (fs.existsSync(dirPath)) {
      const filePath = path.resolve(dirPath, 'watcherTasks.xml');
      await (doesContainJsOrTs(config) || doesContainJava(config)
        ? promisePool.run(() => fsUtil.generateFile(filePath, getWatcherTasksContent(config)))
        : promisePool.run(() => fs.promises.rm(filePath, { force: true })));
      // Only Java repositories keep Prettier (via prettier-plugin-java); everywhere else a
      // leftover prettier.xml is a stale artifact of the pre-oxfmt setup.
      if (!doesContainJava(config)) {
        await promisePool.run(() => fs.promises.rm(path.resolve(dirPath, 'prettier.xml'), { force: true }));
      }
    }
  });
}

function getWatcherTasksContent(config: PackageConfig): string {
  const taskOptions = [
    {
      args: '--write --no-error-on-unmatched-pattern !**/package.json',
      condition: doesContainJsOrTs(config),
      extensions: extensions.oxfmt,
      name: 'Oxfmt',
      program: oxfmtProgram,
    },
    {
      args: '--cache --write',
      condition: doesContainJava(config),
      extensions: extensions.prettierOnly,
      name: 'Prettier',
      program: prettierProgram,
    },
  ]
    .filter((task) => task.condition)
    .flatMap((task) => task.extensions.map((ext) => createTaskOptions(task.program, task.args, task.name, ext)));

  return `<?xml version="1.0" encoding="UTF-8"?>
<project version="4">
  <component name="ProjectTasksOptions">
    ${taskOptions.join('')}
  </component>
</project>
`;
}

function createTaskOptions(runner: string, args: string, name: string, extension: string): string {
  return `    <TaskOptions isEnabled="true">
      <option name="arguments" value="${args} $FilePathRelativeToProjectRoot$" />
      <option name="checkSyntaxErrors" value="false" />
      <option name="description" />
      <option name="exitCodeBehavior" value="ERROR" />
      <option name="fileExtension" value="${extension}" />
      <option name="immediateSync" value="false" />
      <option name="name" value="${name} (.${extension})" />
      <option name="output" value="$FilePathRelativeToProjectRoot$" />
      <option name="outputFilters">
        <array />
      </option>
      <option name="outputFromStdout" value="false" />
      <option name="program" value="${runner}" />
      <option name="runOnExternalChanges" value="false" />
      <option name="scopeName" value="Project Files" />
      <option name="trackOnlyRoot" value="false" />
      <option name="workingDir" value="$ProjectFileDir$" />
      <envs />
    </TaskOptions>
`;
}
