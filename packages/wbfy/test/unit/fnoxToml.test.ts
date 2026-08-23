import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { expect, test } from 'bun:test';

import {
  generateFnoxToml,
  getFnoxAgeRecipients,
  hasFnoxSyncFailed,
  isTestFixtureFnoxPath,
  matchesFnoxRepositoryScope,
} from '../../src/generators/fnoxToml.js';
import { createConfig } from '../helpers/testConfig.js';

test('selects the CI identity by repository visibility', () => {
  const developerNames = ['exkazuu', 'ponharu1', 'ponharu2'];

  expect(
    getFnoxAgeRecipients(createConfig({ repository: 'github:WillBooster/example', isPublicRepo: false })).map(
      ({ name }) => name
    )
  ).toEqual([...developerNames, 'ci', 'remin']);
  expect(
    getFnoxAgeRecipients(createConfig({ repository: 'github:WillBoosterLab/example', isPublicRepo: false })).map(
      ({ name }) => name
    )
  ).toEqual([...developerNames, 'ci', 'remin']);
  expect(
    getFnoxAgeRecipients(createConfig({ repository: 'github:WillBooster/example', isPublicRepo: true })).map(
      ({ name }) => name
    )
  ).toEqual([...developerNames, 'ci-public', 'remin']);
  // A public WillBoosterLab repository resolves NO CI identity (PUBLIC_FNOX_AGE_KEY is registered
  // only in the WillBooster organization); generateFnoxToml fails closed on it.
  expect(
    getFnoxAgeRecipients(createConfig({ repository: 'github:WillBoosterLab/example', isPublicRepo: true })).map(
      ({ name }) => name
    )
  ).toEqual([...developerNames, 'remin']);
  // An unknown visibility (failed GitHub lookup) grants NEITHER CI identity; generateFnoxToml
  // fails instead of rewriting recipients in that state.
  expect(
    getFnoxAgeRecipients(
      createConfig({ repository: 'github:WillBooster/example', isPublicRepo: false, isRepoVisibilityKnown: false })
    ).map(({ name }) => name)
  ).toEqual([...developerNames, 'remin']);
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

test('matches visibility-constrained fnox repository scopes only when the visibility is known and agrees', () => {
  const publicScope = { organizations: ['WillBooster'], visibility: 'public' } as const;
  const privateScope = { organizations: ['WillBooster'], visibility: 'private' } as const;

  expect(matchesFnoxRepositoryScope(publicScope, createConfig({ isPublicRepo: true }))).toBe(true);
  expect(matchesFnoxRepositoryScope(publicScope, createConfig({ isPublicRepo: false }))).toBe(false);
  expect(matchesFnoxRepositoryScope(privateScope, createConfig({ isPublicRepo: false }))).toBe(true);
  expect(matchesFnoxRepositoryScope(privateScope, createConfig({ isPublicRepo: true }))).toBe(false);
  expect(
    matchesFnoxRepositoryScope(publicScope, createConfig({ isPublicRepo: true, isRepoVisibilityKnown: false }))
  ).toBe(false);
  expect(
    matchesFnoxRepositoryScope(privateScope, createConfig({ isPublicRepo: false, isRepoVisibilityKnown: false }))
  ).toBe(false);
});

test('grants aries fnox access only to the selected repositories', () => {
  const ariesRecipient = {
    name: 'aries',
    publicKey: 'age1nn0ehyaenyq8kmnq4294kzzgxv5dnf6pep2cdkraxzfqlk7xgsrqqn6nn9',
  };
  const selectedRepositories = [
    'WillBooster/agent-challenges',
    'WillBooster/agentic-workflows-dashboard',
    'WillBooster/cheerlings',
    'WillBooster/chofu-walking',
    'WillBooster/prompt-study',
    'WillBooster/exercode',
    'WillBooster/judge',
  ];

  for (const repository of selectedRepositories) {
    expect(getFnoxAgeRecipients(createConfig({ repository: `github:${repository}` }))).toContainEqual(ariesRecipient);
  }
  expect(getFnoxAgeRecipients(createConfig({ repository: 'github:WillBooster/shared' }))).not.toContainEqual(
    ariesRecipient
  );
  expect(getFnoxAgeRecipients(createConfig({ repository: 'github:WillBoosterLab/example' }))).not.toContainEqual(
    ariesRecipient
  );
});

test('grants sunaga and ayame fnox access only to their selected repositories', () => {
  const sunagaRecipient = {
    name: 'sunaga',
    publicKey: 'age1ulxzn6y68ku34cpx5fya5gf7rnrwz0uflnye6uxuhg34p2njhgkqmg73g4',
  };
  const ayameRecipient = {
    name: 'ayame',
    publicKey: 'age1vxm2gs003ruwm8p6h3hv7xasju2s8k4mxmc34zm6grdwznrs09nq6xz5vz',
  };

  for (const repository of ['WillBooster/exercode', 'WillBooster/judge']) {
    const recipients = getFnoxAgeRecipients(createConfig({ repository: `github:${repository}` }));
    expect(recipients).toContainEqual(sunagaRecipient);
    expect(recipients).toContainEqual(ayameRecipient);
  }

  const chofuWalkingRecipients = getFnoxAgeRecipients(createConfig({ repository: 'github:WillBooster/chofu-walking' }));
  expect(chofuWalkingRecipients).not.toContainEqual(sunagaRecipient);
  expect(chofuWalkingRecipients).toContainEqual(ayameRecipient);

  for (const repository of ['WillBooster/shared', 'WillBoosterLab/example']) {
    const recipients = getFnoxAgeRecipients(createConfig({ repository: `github:${repository}` }));
    expect(recipients).not.toContainEqual(sunagaRecipient);
    expect(recipients).not.toContainEqual(ayameRecipient);
  }
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
