import fs from 'node:fs';
import path from 'node:path';

import { logger } from '../logger.js';
import type { PackageConfig } from '../packageConfig.js';
import { extensions } from '../utils/extensions.js';
import { fsUtil } from '../utils/fsUtil.js';
import { doesContainJava } from '../utils/packageCapabilities.js';
import { promisePool } from '../utils/promisePool.js';

// Keep package-manager shims in the File Watcher program field so node does not
// parse wrapper scripts passed through arguments.
const prettierProgram = '$ProjectFileDir$/node_modules/.bin/prettier';

export async function generateIdeaSettings(config: PackageConfig): Promise<void> {
  return logger.functionIgnoringException('generateIdeaSettings', async () => {
    const dirPath = path.resolve(config.dirPath, '.idea');
    if (fs.existsSync(dirPath)) {
      const filePath = path.resolve(dirPath, 'watcherTasks.xml');
      await promisePool.runAndWaitForReturnValue(() => fsUtil.generateFile(filePath, getWatcherTasksContent(config)));
    }
  });
}

function getWatcherTasksContent(config: PackageConfig): string {
  const tasks = [
    {
      args: 'fmt --no-script --no-error-on-unmatched-pattern',
      extensions: extensions.bunFmt,
      name: 'Bun fmt',
      program: 'bun',
    },
    ...(doesContainJava(config)
      ? [{ args: '--cache --write', extensions: extensions.prettierOnly, name: 'Prettier', program: prettierProgram }]
      : []),
  ];
  const taskOptions = tasks.flatMap((task) =>
    task.extensions.map((ext) => createTaskOptions(task.program, task.args, task.name, ext))
  );

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
