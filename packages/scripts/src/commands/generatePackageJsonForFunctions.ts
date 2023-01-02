import fs from 'node:fs/promises';
import path from 'node:path';

import { PackageJson } from 'type-fest';
import { CommandModule, InferredOptionTypes } from 'yargs';

const builder = {
  'input-dir': {
    description: 'A input directory',
    type: 'string',
    default: '.',
    alias: 'i',
  },
  'output-dir': {
    description: 'A output directory',
    type: 'string',
    default: 'dist',
    alias: 'o',
  },
} as const;

export const generatePackageJsonForFunctions: CommandModule<unknown, InferredOptionTypes<typeof builder>> = {
  command: 'generatePackageJsonForFunctions',
  describe: ' Generate package.json for Firebase / GCP Functions',
  builder,
  async handler(argv) {
    const outputDirPath = path.resolve(argv.outputDir);
    await fs.rm(outputDirPath, { force: true, recursive: true });
    await fs.mkdir(outputDirPath, { recursive: true });

    const inputDirPath = path.resolve(argv.inputDir);
    const packageJsonText = await fs.readFile(path.resolve(inputDirPath, 'package.json'), 'utf8');
    const packageJson = JSON.parse(packageJsonText) as PackageJson;

    const mainPath = packageJson.main as string;
    packageJson.main = mainPath.split('/')[1];
    delete packageJson.devDependencies;
    await Promise.all([
      fs.writeFile(path.join(outputDirPath, 'package.json'), JSON.stringify(packageJson)),
      fs.writeFile(mainPath, ''),
    ]);
  },
};
