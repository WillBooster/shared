import { afterEach, describe, expect, it } from 'vitest';

import {
  isPrivateRegistryDependency,
  materializedVersionSatisfies,
  parseNpmrc,
  selectVersionFromPackument,
  specifierSubset,
} from '../../src/utils/privateRegistry.js';

describe('isPrivateRegistryDependency', () => {
  it('accepts registry ranges for the private scope only', () => {
    expect(isPrivateRegistryDependency('@willbooster-private/agentic-workflows', '1.2.3')).toBe(true);
    expect(isPrivateRegistryDependency('@willbooster-private/llm-proxy', '^1.2.3')).toBe(true);
    expect(isPrivateRegistryDependency('@willbooster/wb', '1.2.3')).toBe(false);
    expect(
      isPrivateRegistryDependency('@willbooster-private/agentic-workflows', 'git@github.com:WillBooster/x.git')
    ).toBe(false);
    expect(isPrivateRegistryDependency('@willbooster-private/agentic-workflows', 'workspace:*')).toBe(false);
    expect(isPrivateRegistryDependency('@willbooster-private/agentic-workflows', 'file:../x')).toBe(false);
  });
});

describe('selectVersionFromPackument', () => {
  const packument = {
    'dist-tags': { latest: '1.4.0', next: '2.0.0-beta.1' },
    versions: Object.fromEntries(
      ['0.9.0', '1.2.3', '1.3.0', '1.4.0', '1.5.0-rc.1', '2.0.0-beta.1'].map((v) => [v, {}])
    ),
  };

  it('resolves ranges to the highest satisfying published version', () => {
    expect(selectVersionFromPackument('^1.2.3', packument)).toBe('1.4.0');
    expect(selectVersionFromPackument('~1.2.0', packument)).toBe('1.2.3');
    expect(selectVersionFromPackument('>=0.9.0 <1.4.0', packument)).toBe('1.3.0');
    expect(selectVersionFromPackument('1.2.x', packument)).toBe('1.2.3');
  });

  it('excludes prereleases from plain ranges but admits them for same-tuple prerelease ranges', () => {
    expect(selectVersionFromPackument('^1.4.0', packument)).toBe('1.4.0');
    expect(selectVersionFromPackument('>=1.5.0-rc.0 <1.5.1', packument)).toBe('1.5.0-rc.1');
  });

  it('resolves * and dist-tags via dist-tags', () => {
    expect(selectVersionFromPackument('*', packument)).toBe('1.4.0');
    expect(selectVersionFromPackument('next', packument)).toBe('2.0.0-beta.1');
    expect(selectVersionFromPackument('latest', packument)).toBe('1.4.0');
  });

  it('returns undefined for unsatisfiable ranges and unknown tags', () => {
    expect(selectVersionFromPackument('^3.0.0', packument)).toBeUndefined();
    expect(selectVersionFromPackument('unknown-tag', packument)).toBeUndefined();
    expect(selectVersionFromPackument('^1.0.0', {})).toBeUndefined();
  });
});

describe('specifierSubset', () => {
  it('accepts a specifier whose every resolution satisfies the requirement', () => {
    expect(specifierSubset('1.2.3', '^1.2.0')).toBe(true);
    expect(specifierSubset('~1.2.3', '^1.2.0')).toBe(true);
    expect(specifierSubset('^1.2.0', '>=1.0.0')).toBe(true);
  });

  it('rejects wider or diverging specifiers', () => {
    // ^1.2.0 may resolve to e.g. 1.9.0, which does not satisfy the exact 1.2.3 requirement.
    expect(specifierSubset('^1.2.0', '1.2.3')).toBe(false);
    expect(specifierSubset('^1.2.0', '~1.2.0')).toBe(false);
    expect(specifierSubset('^2.0.0', '^1.0.0')).toBe(false);
  });

  it('rejects non-range specifiers (dist-tags, git URLs)', () => {
    expect(specifierSubset('latest', '^1.0.0')).toBe(false);
    expect(specifierSubset('1.2.3', 'some-tag')).toBe(false);
    expect(specifierSubset('git@github.com:WillBooster/x.git', 'git@github.com:WillBooster/x.git')).toBe(false);
    expect(specifierSubset(undefined, '^1.0.0')).toBe(false);
  });
});

describe('materializedVersionSatisfies', () => {
  it('checks ranges and exact versions against the materialized version', () => {
    expect(materializedVersionSatisfies('^1.2.0', '1.4.0')).toBe(true);
    expect(materializedVersionSatisfies('^1.2.0', '2.0.0')).toBe(false);
    expect(materializedVersionSatisfies('1.2.3', '1.2.3')).toBe(true);
    expect(materializedVersionSatisfies('1.2.3', '1.2.4')).toBe(false);
    expect(materializedVersionSatisfies('1.2.3-beta.1', '1.2.3-beta.1')).toBe(true);
  });

  it('passes dist-tag specifiers, which are not statically checkable', () => {
    expect(materializedVersionSatisfies('2026-stable', '1.4.0')).toBe(true);
  });
});

describe('parseNpmrc', () => {
  afterEach(() => {
    delete process.env.TEST_VERDACCIO_TOKEN;
  });

  it('parses entries and expands environment variable references', () => {
    process.env.TEST_VERDACCIO_TOKEN = 'secret-token';
    const entries = parseNpmrc(`# comment
@willbooster-private:registry=https://verdaccio.example.com/
//verdaccio.example.com/:_authToken=\${TEST_VERDACCIO_TOKEN}
legacy-peer-deps=true
`);
    expect(entries).toEqual({
      '@willbooster-private:registry': 'https://verdaccio.example.com/',
      '//verdaccio.example.com/:_authToken': 'secret-token',
      'legacy-peer-deps': 'true',
    });
  });
});
