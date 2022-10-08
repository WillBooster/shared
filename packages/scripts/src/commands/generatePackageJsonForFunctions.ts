import fs from 'node:fs';
import path from 'node:path';

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
    fs.rmSync(outputDirPath, { force: true, recursive: true });
    fs.mkdirSync(outputDirPath, { recursive: true });

    const inputDirPath = path.resolve(argv.inputDir);
    const packageJsonText = fs.readFileSync(path.resolve(inputDirPath, 'package.json'), 'utf8');
    const packageJson = JSON.parse(packageJsonText);

    const mainPath = packageJson.main;
    packageJson.main = mainPath.split('/')[1];
    delete packageJson.devDependencies;
    fs.writeFileSync(path.join(outputDirPath, 'package.json'), JSON.stringify(packageJson));
    fs.writeFileSync(mainPath, '');
  },
};
