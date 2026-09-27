import { expect, test } from 'bun:test';

import { parseGitHubRepositoryFullName } from '../../src/github.js';

test('parseGitHubRepositoryFullName accepts owner/repo and rejects other shapes', () => {
  expect(parseGitHubRepositoryFullName('WillBooster/shared')).toEqual({ owner: 'WillBooster', repo: 'shared' });
  expect(parseGitHubRepositoryFullName('my-org/repo.name_1')).toEqual({ owner: 'my-org', repo: 'repo.name_1' });
  for (const invalid of ['shared', 'a/b/c', 'owner/..', 'owner/.', 'own_er/repo', '/repo', 'owner/']) {
    expect(parseGitHubRepositoryFullName(invalid)).toBeUndefined();
  }
});
