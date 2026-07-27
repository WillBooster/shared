import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { expect, test } from 'vitest';

import {
  generateFnoxToml,
  getFnoxAgeRecipients,
  hasFnoxSyncFailed,
  isTestFixtureFnoxPath,
  matchesFnoxRepositoryScope,
} from '../../src/generators/fnoxToml.js';
import { createConfig } from '../helpers/testConfig.js';

test('keeps the existing age recipient roster for both WillBooster organizations', () => {
  const recipientNames = ['exkazuu', 'ponharu1', 'ponharu2', 'ci', 'remin'];

  expect(
    getFnoxAgeRecipients(createConfig({ repository: 'github:WillBooster/example' })).map(({ name }) => name)
  ).toEqual(recipientNames);
  expect(
    getFnoxAgeRecipients(createConfig({ repository: 'github:WillBoosterLab/example' })).map(({ name }) => name)
  ).toEqual(recipientNames);
});

test('matches fnox repository scopes by organization or exact repository', () => {
  const scope = {
    organizations: ['WillBoosterLab'],
    repositories: ['WillBooster/selected'],
  } as const;

  expect(matchesFnoxRepositoryScope(scope, createConfig({ repository: 'github:WillBoosterLab/any-repository' }))).toBe(
    true
  );
  expect(matchesFnoxRepositoryScope(scope, createConfig({ repository: 'github:willbooster/SELECTED' }))).toBe(true);
  expect(matchesFnoxRepositoryScope(scope, createConfig({ repository: 'github:WillBooster/other' }))).toBe(false);
  expect(
    matchesFnoxRepositoryScope(
      { repositories: ['WillBooster/selected'] },
      createConfig({ repository: 'github:WillBoosterLab/selected' })
    )
  ).toBe(false);
  expect(matchesFnoxRepositoryScope(scope, createConfig({ repository: undefined }))).toBe(false);
});

test('keeps the age recipients of a repository outside the WillBooster organizations', async () => {
  const dirPath = fs.mkdtempSync(path.join(os.tmpdir(), 'wbfy-fnox-'));
  try {
    const originalContent = `[providers.age]
type = "age"
recipients = [
  "age1j2354xhvm3fv9y77t5g6y3q8mexgk2mf00tgrkzgp73tynrvz55s8auayw", # owner
  "age19dsxzka9av9h242rhqmexd6amp4k350xqkfufyhmydacceegh5lqa9l605", # ci-owner
]

[secrets]
`;
    fs.writeFileSync(path.join(dirPath, 'fnox.toml'), originalContent);
    await generateFnoxToml(createConfig({ dirPath, repository: 'github:example/example', isWillBoosterRepo: false }));

    expect(fs.readFileSync(path.join(dirPath, 'fnox.toml'), 'utf8')).toBe(originalContent);
    // Assert the synchronization flag itself, which generateFnoxToml resets on every call. The
    // process-global process.exitCode is never reset and every failure path of this module writes
    // it, so a failure-path test added to this file would contaminate that assertion.
    expect(hasFnoxSyncFailed()).toBe(false);
  } finally {
    fs.rmSync(dirPath, { force: true, recursive: true });
  }
});

test('exempts fnox configs only under test-fixture trees', () => {
  expect(isTestFixtureFnoxPath('test/fixtures/app/fnox.toml')).toBe(true);
  expect(isTestFixtureFnoxPath('packages/lib/tests/fixtures/fnox.toml')).toBe(true);
  expect(isTestFixtureFnoxPath('test-fixtures/app/fnox.toml')).toBe(true);
  expect(isTestFixtureFnoxPath('src/__tests__/fnox.toml')).toBe(true);
  // A legitimate `fixtures` workspace must stay managed and verified.
  expect(isTestFixtureFnoxPath('packages/fixtures/fnox.toml')).toBe(false);
  expect(isTestFixtureFnoxPath('fnox.toml')).toBe(false);
});
