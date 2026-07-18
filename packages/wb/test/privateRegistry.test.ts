import { afterEach, describe, expect, it } from 'vitest';

import { isPrivateRegistryDependency, parseNpmrc } from '../src/utils/privateRegistry.js';

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
