import fs from 'node:fs';
import path from 'node:path';

import { logger } from '../logger.js';
import type { PackageConfig } from '../packageConfig.js';
import { extensions } from '../utils/extensions.js';
import { fsUtil } from '../utils/fsUtil.js';
import { promisePool } from '../utils/promisePool.js';

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

const prettierContent = `<?xml version="1.0" encoding="UTF-8"?>
<project version="4">
  <component name="ProjectTasksOptions">
${extensions.prettier.map((ext) => createTaskOptions('node', 'node_modules/.bin/prettier --cache --write', 'Prettier', ext)).join('')}
  </component>
</project>
`;

const biomeContent = `<?xml version="1.0" encoding="UTF-8"?>
<project version="4">
  <component name="ProjectTasksOptions">
${extensions.prettier.map((ext) => createTaskOptions('bun', '--bun node_modules/.bin/biome check --fix --no-errors-on-unmatched --skip-parse-errors', 'Biome', ext)).join('')}
  </component>
</project>
`;

export async function generateIdeaSettings(config: PackageConfig): Promise<void> {
  return logger.functionIgnoringException('generateIdeaSettings', async () => {
    const dirPath = path.resolve(config.dirPath, '.idea');
    if (fs.existsSync(dirPath)) {
      const filePath = path.resolve(dirPath, 'watcherTasks.xml');
      await (config.doesContainJavaScript ||
      config.doesContainJavaScriptInPackages ||
      config.doesContainTypeScript ||
      config.doesContainTypeScriptInPackages ||
      (config.doesContainPackageJson &&
        !config.doesContainPubspecYaml &&
        !config.doesContainGemfile &&
        !config.doesContainGoMod &&
        !config.doesContainPomXml)
        ? promisePool.run(() => fsUtil.generateFile(filePath, config.isBun ? biomeContent : prettierContent))
        : promisePool.run(() => fs.promises.rm(filePath, { force: true })));
    }
  });
}
