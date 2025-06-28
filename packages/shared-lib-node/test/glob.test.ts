import fs from 'node:fs';
import path from 'node:path';

import { beforeAll, expect, test } from 'vitest';

import { glob, globSync } from '../src/glob.js';

const rootDirPath = path.resolve('test/fixtures', 'temp', 'glob1');
const srcDirPath = path.resolve(rootDirPath, 'src');
const nodeModuleDirPath = path.resolve(rootDirPath, 'node_modules');
const packageDirPath = path.resolve(nodeModuleDirPath, 'package1');

const rootFilePath = path.resolve(rootDirPath, 'test.txt');
const srcFilePath = path.resolve(srcDirPath, 'test.js');
const nodeModuleFilePath = path.resolve(nodeModuleDirPath, 'test.txt');
const packageFilePath = path.resolve(packageDirPath, 'test.js');

beforeAll(() => {
  fs.rmSync(rootDirPath, { force: true, recursive: true });
  fs.mkdirSync(rootDirPath, { recursive: true });
  fs.mkdirSync(srcDirPath, { recursive: true });
  fs.mkdirSync(nodeModuleDirPath, { recursive: true });
  fs.mkdirSync(packageDirPath, { recursive: true });
  fs.writeFileSync(rootFilePath, 'test');
  fs.writeFileSync(srcFilePath, 'test');
  fs.writeFileSync(nodeModuleFilePath, 'test');
  fs.writeFileSync(packageFilePath, 'test');
});

test('should glob all files with **/* pattern', async () => {
  const files = [];
  for await (const file of glob('**/*', { cwd: rootDirPath, onlyFiles: true })) {
    files.push(path.join(file.parentPath, file.name));
  }
  expect(files.sort()).toEqual([rootFilePath, srcFilePath, nodeModuleFilePath, packageFilePath].sort());
});

test('should glob only .txt files', async () => {
  const files = [];
  for await (const file of glob('**/*.txt', { cwd: rootDirPath, onlyFiles: true })) {
    files.push(path.join(file.parentPath, file.name));
  }
  expect(files.sort()).toEqual([rootFilePath, nodeModuleFilePath].sort());
});

test('should respect excludes option', async () => {
  const files = [];
  for await (const file of glob('**/*', {
    cwd: rootDirPath,
    onlyFiles: true,
    excludes: [/\/node_modules(?:\/|$)/],
  })) {
    files.push(path.join(file.parentPath, file.name));
  }
  expect(files.sort()).toEqual([rootFilePath, srcFilePath].sort());
});

test('should handle multiple exclude patterns', async () => {
  const files = [];
  for await (const file of glob('**/*', {
    cwd: rootDirPath,
    onlyFiles: true,
    excludes: [/\/node_modules(?:\/|$)/, /\/src(?:\/|$)/],
  })) {
    files.push(path.join(file.parentPath, file.name));
  }
  expect(files.sort()).toEqual([rootFilePath].sort());
});

test('should include directories when onlyFiles is false', async () => {
  const entries = [];
  for await (const entry of glob('**/*', { cwd: rootDirPath, onlyFiles: false })) {
    entries.push(path.join(entry.parentPath, entry.name));
  }
  expect(entries.sort()).toEqual(
    [
      rootFilePath,
      srcFilePath,
      nodeModuleFilePath,
      packageFilePath,
      srcDirPath,
      nodeModuleDirPath,
      packageDirPath,
    ].sort()
  );
});

test('should respect excludes with directories', async () => {
  const entries = [];
  for await (const entry of glob('**/*', {
    cwd: rootDirPath,
    onlyFiles: false,
    excludes: [/\/node_modules(?:\/|$)/],
  })) {
    entries.push(path.join(entry.parentPath, entry.name));
  }
  expect(entries.sort()).toEqual([rootFilePath, srcFilePath, srcDirPath].sort());
});

test('should glob all files with **/* pattern (sync)', () => {
  const files = globSync('**/*', { cwd: rootDirPath, onlyFiles: true }).map((file) =>
    path.join(file.parentPath, file.name)
  );
  expect(files.sort()).toEqual([rootFilePath, srcFilePath, nodeModuleFilePath, packageFilePath].sort());
});

test('should glob only .txt files (sync)', () => {
  const files = globSync('**/*.txt', { cwd: rootDirPath, onlyFiles: true }).map((file) =>
    path.join(file.parentPath, file.name)
  );
  expect(files.sort()).toEqual([rootFilePath, nodeModuleFilePath].sort());
});

test('should respect excludes option (sync)', () => {
  const files = globSync('**/*', {
    cwd: rootDirPath,
    onlyFiles: true,
    excludes: [/\/node_modules(?:\/|$)/],
  }).map((file) => path.join(file.parentPath, file.name));
  expect(files.sort()).toEqual([rootFilePath, srcFilePath].sort());
});

test('should handle multiple exclude patterns (sync)', () => {
  const files = globSync('**/*', {
    cwd: rootDirPath,
    onlyFiles: true,
    excludes: [/\/node_modules(?:\/|$)/, /\/src(?:\/|$)/],
  }).map((file) => path.join(file.parentPath, file.name));
  expect(files.sort()).toEqual([rootFilePath].sort());
});

test('should include directories when onlyFiles is false (sync)', () => {
  const entries = globSync('**/*', { cwd: rootDirPath, onlyFiles: false }).map((entry) =>
    path.join(entry.parentPath, entry.name)
  );
  expect(entries.sort()).toEqual(
    [
      rootFilePath,
      srcFilePath,
      nodeModuleFilePath,
      packageFilePath,
      srcDirPath,
      nodeModuleDirPath,
      packageDirPath,
    ].sort()
  );
});

test('should respect excludes with directories (sync)', () => {
  const entries = globSync('**/*', {
    cwd: rootDirPath,
    onlyFiles: false,
    excludes: [/\/node_modules(?:\/|$)/],
  }).map((entry) => path.join(entry.parentPath, entry.name));
  expect(entries.sort()).toEqual([rootFilePath, srcFilePath, srcDirPath].sort());
});
