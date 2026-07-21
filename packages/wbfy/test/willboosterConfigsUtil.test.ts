import { describe, expect, it } from 'bun:test';

import { resolveWillboosterConfigModule } from '../src/utils/willboosterConfigsUtil.js';

import { createConfig } from './testConfig.js';

describe('resolveWillboosterConfigModule', () => {
  const rootConfig = createConfig({ dirPath: '/repo/willbooster-configs', isRoot: true, isWillBoosterConfigs: true });

  it('returns the published package name outside willbooster-configs', () => {
    const config = createConfig({ dirPath: '/repo/other', isWillBoosterConfigs: false });
    expect(resolveWillboosterConfigModule(config, rootConfig, '@willbooster/oxlint-config')).toBe(
      '@willbooster/oxlint-config'
    );
  });

  // Inside willbooster-configs the config packages import one another, so a declared dependency edge
  // would form a cycle that multi-semantic-release cannot sort. The generated config must therefore
  // load the committed local build output via a relative path instead of the unresolvable bare name.
  it('resolves a relative path to the local config.mjs from the repository root', () => {
    expect(resolveWillboosterConfigModule(rootConfig, rootConfig, '@willbooster/oxfmt-config')).toBe(
      './packages/oxfmt-config/config.mjs'
    );
  });

  it('resolves a relative path from a sibling package under packages/', () => {
    const config = createConfig({ dirPath: '/repo/willbooster-configs/packages/shared', isWillBoosterConfigs: true });
    expect(resolveWillboosterConfigModule(config, rootConfig, '@willbooster/oxlint-config')).toBe(
      '../oxlint-config/config.mjs'
    );
  });

  it('resolves to ./config.mjs when a config package consumes itself', () => {
    const config = createConfig({
      dirPath: '/repo/willbooster-configs/packages/oxlint-config',
      isWillBoosterConfigs: true,
    });
    expect(resolveWillboosterConfigModule(config, rootConfig, '@willbooster/oxlint-config')).toBe('./config.mjs');
  });
});
