import fs from 'node:fs';
import path from 'node:path';

import { logger } from '../logger.js';
import type { PackageConfig } from '../packageConfig.js';
import { extensions } from '../utils/extensions.js';
import { fsUtil } from '../utils/fsUtil.js';
import { doesContainJava, doesContainJsOrTs } from '../utils/packageCapabilities.js';
import { promisePool } from '../utils/promisePool.js';

// IDEA invokes File Watcher arguments through node, so pass JavaScript entrypoints
// instead of package-manager wrapper scripts.
const oxfmtNodeEntrypoint = 'node_modules/oxfmt/bin/oxfmt';
// wbfy installs the current Prettier package, so generated watchers use the current bin layout.
const prettierNodeEntrypoint = 'node_modules/prettier/bin/prettier.cjs';

export async function generateIdeaSettings(config: PackageConfig): Promise<void> {
  return logger.functionIgnoringException('generateIdeaSettings', async () => {
    const dirPath = path.resolve(config.dirPath, '.idea');
    if (fs.existsSync(dirPath)) {
      const filePath = path.resolve(dirPath, 'watcherTasks.xml');
      await (doesContainJsOrTs(config) || doesContainJava(config)
        ? promisePool.run(() => fsUtil.generateFile(filePath, getWatcherTasksContent(config)))
        : promisePool.run(() => fs.promises.rm(filePath, { force: true })));
    }
  });
}

function getWatcherTasksContent(config: PackageConfig): string {
  const taskOptions: string[] = [];
  if (doesContainJsOrTs(config)) {
    const args = `${oxfmtNodeEntrypoint} --write --no-error-on-unmatched-pattern !**/package.json`;
    taskOptions.push(...extensions.oxfmt.map((ext) => createTaskOptions('node', args, 'Oxfmt', ext)));
  }
  if (doesContainJava(config)) {
    const args = `${prettierNodeEntrypoint} --cache --write`;
    taskOptions.push(...extensions.prettierOnly.map((ext) => createTaskOptions('node', args, 'Prettier', ext)));
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<project version="4">
  <component name="ProjectTasksOptions">
${taskOptions.join('')}  </component>
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
