import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { expect, test } from 'vitest';

import { consumesGeneratedWorkerTypes } from '../../src/packageConfig.js';

async function consumesWithTsconfig(tsconfigContent: string | undefined): Promise<boolean> {
  const dirPath = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'wbfy-worker-types-'));
  try {
    if (tsconfigContent !== undefined) {
      await fs.promises.writeFile(path.join(dirPath, 'tsconfig.json'), tsconfigContent);
    }
    return consumesGeneratedWorkerTypes({ dirPath });
  } finally {
    await fs.promises.rm(dirPath, { force: true, recursive: true });
  }
}

test('treats a missing, unparseable, or unrestricted tsconfig as consuming worker types', async () => {
  expect(await consumesWithTsconfig(undefined)).toBe(true);
  expect(await consumesWithTsconfig('{ broken')).toBe(true);
  // No include/files: TypeScript's default `**` inclusion covers the root-level file.
  expect(await consumesWithTsconfig('{ "compilerOptions": { "strict": true } }')).toBe(true);
});

test('detects include/files entries that can match the root-level worker-configuration.d.ts', async () => {
  expect(await consumesWithTsconfig('{ "include": ["worker-configuration.d.ts", "src/**/*"] }')).toBe(true);
  expect(await consumesWithTsconfig('{ "include": ["./worker-configuration.d.ts"] }')).toBe(true);
  expect(await consumesWithTsconfig('{ "include": ["**/*"] }')).toBe(true);
  expect(await consumesWithTsconfig('{ "include": ["**"] }')).toBe(true);
  expect(await consumesWithTsconfig('{ "include": ["*.ts"] }')).toBe(true);
  expect(await consumesWithTsconfig('{ "include": ["."] }')).toBe(true);
  expect(await consumesWithTsconfig('{ "files": ["worker-configuration.d.ts"] }')).toBe(true);
});

test('honors exclude and relative extends chains when resolving the effective file set', async () => {
  // `exclude` removes the file from a wildcard include...
  expect(await consumesWithTsconfig('{ "include": ["**/*"], "exclude": ["worker-configuration.d.ts"] }')).toBe(false);
  // ...but `files` entries are always part of the program, even when excluded.
  expect(
    await consumesWithTsconfig(
      '{ "files": ["worker-configuration.d.ts"], "include": [], "exclude": ["worker-configuration.d.ts"] }'
    )
  ).toBe(true);

  const dirPath = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'wbfy-worker-types-extends-'));
  try {
    await fs.promises.writeFile(path.join(dirPath, 'tsconfig.base.json'), '{ "include": ["src/**/*"] }');
    await fs.promises.writeFile(
      path.join(dirPath, 'tsconfig.json'),
      '{ "extends": "./tsconfig.base.json", "compilerOptions": {} }'
    );
    // The source-only include inherited from the base config cannot match the root-level file.
    expect(consumesGeneratedWorkerTypes({ dirPath })).toBe(false);

    // A package-name extends contributes no file set, so the default `**` inclusion applies.
    await fs.promises.writeFile(path.join(dirPath, 'tsconfig.json'), '{ "extends": "@tsconfig/bun/tsconfig.json" }');
    expect(consumesGeneratedWorkerTypes({ dirPath })).toBe(true);

    // Inherited patterns stay relative to the config that declared them (tsc semantics): a base
    // config one level up whose include covers the package DOES reach the package's root file.
    const packageDirPath = path.join(dirPath, 'pkg');
    await fs.promises.mkdir(packageDirPath);
    await fs.promises.writeFile(path.join(dirPath, 'tsconfig.base.json'), '{ "include": ["pkg/**/*"] }');
    await fs.promises.writeFile(path.join(packageDirPath, 'tsconfig.json'), '{ "extends": "../tsconfig.base.json" }');
    expect(consumesGeneratedWorkerTypes({ dirPath: packageDirPath })).toBe(true);
    // `${configDir}` resolves to the consuming package's directory, wherever declared.
    await fs.promises.writeFile(path.join(packageDirPath, 'tsconfig.json'), '{ "include": ["${configDir}/**/*"] }');
    expect(consumesGeneratedWorkerTypes({ dirPath: packageDirPath })).toBe(true);
    // A directory include (extensionless, no glob) covers its whole subtree, like tsc.
    await fs.promises.writeFile(path.join(dirPath, 'tsconfig.base.json'), '{ "include": ["pkg"] }');
    await fs.promises.writeFile(path.join(packageDirPath, 'tsconfig.json'), '{ "extends": "../tsconfig.base.json" }');
    expect(consumesGeneratedWorkerTypes({ dirPath: packageDirPath })).toBe(true);
    // ...while a base config covering only a sibling directory does not.
    await fs.promises.writeFile(path.join(dirPath, 'tsconfig.base.json'), '{ "include": ["other/**/*"] }');
    expect(consumesGeneratedWorkerTypes({ dirPath: packageDirPath })).toBe(false);
  } finally {
    await fs.promises.rm(dirPath, { force: true, recursive: true });
  }
});

test('counts tracked source mentions as consumption but ignores the managed .gitignore rule', async () => {
  const dirPath = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'wbfy-worker-types-git-'));
  const git = (...args: string[]): Buffer =>
    execFileSync('git', args, { cwd: dirPath, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } });
  try {
    git('init', '--initial-branch=main');
    // wbfy's own committed artifacts must not count as consumption, or a once-managed package
    // could never opt out.
    await fs.promises.writeFile(path.join(dirPath, '.gitignore'), '/worker-configuration.d.ts\n');
    await fs.promises.writeFile(path.join(dirPath, 'tsconfig.json'), '{ "include": ["src/**/*"] }');
    git('add', '-A');
    expect(consumesGeneratedWorkerTypes({ dirPath })).toBe(false);

    // A tracked tsconfig mentioning the file (here: an exclude entry) is classified by the
    // resolved file-set logic, not the grep — the exclusion must win.
    await fs.promises.writeFile(
      path.join(dirPath, 'tsconfig.json'),
      '{ "include": ["**/*"], "exclude": ["worker-configuration.d.ts"] }'
    );
    git('add', '-A');
    expect(consumesGeneratedWorkerTypes({ dirPath })).toBe(false);
    await fs.promises.writeFile(path.join(dirPath, 'tsconfig.json'), '{ "include": ["src/**/*"] }');
    git('add', '-A');

    // A genuine reference in a tracked source file DOES count.
    await fs.promises.mkdir(path.join(dirPath, 'src'));
    await fs.promises.writeFile(
      path.join(dirPath, 'src', 'index.ts'),
      '/// <reference path="../worker-configuration.d.ts" />\n'
    );
    git('add', '-A');
    expect(consumesGeneratedWorkerTypes({ dirPath })).toBe(true);
  } finally {
    await fs.promises.rm(dirPath, { force: true, recursive: true });
  }
});

test('opts out when the explicit include/files set cannot match the generated file', async () => {
  // The llm-proxy/cheerlings shape: hand-maintained Env with `types: ["bun"]` and source-only includes.
  expect(await consumesWithTsconfig('{ "include": ["*.config.ts", "scripts/**/*", "src/**/*", "test/**/*"] }')).toBe(
    false
  );
  expect(await consumesWithTsconfig('{ "include": ["src"] }')).toBe(false);
  expect(await consumesWithTsconfig('{ "files": ["src/index.ts"] }')).toBe(false);
  expect(await consumesWithTsconfig('{ "include": [] }')).toBe(false);
});
