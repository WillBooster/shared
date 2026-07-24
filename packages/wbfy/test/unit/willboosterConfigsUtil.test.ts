import { describe, expect, it } from 'vitest';

import { resolveWillboosterConfigModule } from '../../src/utils/willboosterConfigsUtil.js';

import { createConfig } from '../helpers/testConfig.js';

describe('resolveWillboosterConfigModule', () => {
  it('returns the published package name outside willbooster-configs', () => {
    const config = createConfig({ dirPath: '/repo/other', isWillBoosterConfigs: false });
    expect(resolveWillboosterConfigModule(config, '@willbooster/oxlint-config')).toBe('@willbooster/oxlint-config');
  });

  // Inside willbooster-configs the config packages import one another, so a declared dependency edge
  // would form a cycle that multi-semantic-release cannot sort. The generated config must therefore
  // load the committed local build output via a relative path instead of the unresolvable bare name.
  it('resolves a relative path to the local config.mjs from the repository root', () => {
    const config = createConfig({ dirPath: '/repo/willbooster-configs', isRoot: true, isWillBoosterConfigs: true });
    expect(resolveWillboosterConfigModule(config, '@willbooster/oxfmt-config')).toBe(
      './packages/oxfmt-config/config.mjs'
    );
  });

  it('resolves a relative path from a sibling package under packages/', () => {
    const config = createConfig({ dirPath: '/repo/willbooster-configs/packages/shared', isWillBoosterConfigs: true });
    expect(resolveWillboosterConfigModule(config, '@willbooster/oxlint-config')).toBe('../oxlint-config/config.mjs');
  });

  it('resolves to ./config.mjs when a config package consumes itself', () => {
    const config = createConfig({
      dirPath: '/repo/willbooster-configs/packages/oxlint-config',
      isWillBoosterConfigs: true,
    });
    expect(resolveWillboosterConfigModule(config, '@willbooster/oxlint-config')).toBe('./config.mjs');
  });

  // `wbfy <repo>/packages/oxlint-config` targets the child directly, so the module path must be
  // derived from the generated package's own location, not the CLI entry, to avoid a nested path.
  it('resolves to ./config.mjs when wbfy is invoked directly on the self-consuming package', () => {
    const config = createConfig({
      dirPath: '/repo/willbooster-configs/packages/oxlint-config',
      isRoot: false,
      isWillBoosterConfigs: true,
    });
    expect(resolveWillboosterConfigModule(config, '@willbooster/oxlint-config')).toBe('./config.mjs');
  });
});
