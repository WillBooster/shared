import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { expect, test } from 'vitest';

import { consumesGeneratedWorkerTypes } from '../src/packageConfig.js';

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
