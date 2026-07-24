import { describe, expect, it } from 'vitest';

import { selectManagedWbVersion } from '../../src/generators/packageJson.js';

// wb >= 19 loads environment variables only from fnox, so wbfy must not materialize such a
// version for repositories without a root fnox.toml (fresh installs, `*`, and upgrades all flow
// through this selection).
describe('selectManagedWbVersion', () => {
  it('keeps the latest version for fnox repositories', () => {
    expect(
      selectManagedWbVersion(
        '19.0.0',
        true,
        () => {
          throw new Error('must not be called');
        },
        '/repo'
      )
    ).toBe('19.0.0');
  });

  it('caps a fnox-only latest version to the latest pre-fnox-only release for non-fnox repositories', () => {
    expect(selectManagedWbVersion('19.1.0', false, () => '18.0.1', '/repo')).toBe('18.0.1');
  });

  it('caps a fnox-only PRE-release version for non-fnox repositories', () => {
    expect(selectManagedWbVersion('19.0.0-alpha.0', false, () => '18.0.1', '/repo')).toBe('18.0.1');
  });

  it('keeps a pre-fnox-only latest version for non-fnox repositories', () => {
    expect(
      selectManagedWbVersion(
        '18.0.1',
        false,
        () => {
          throw new Error('must not be called');
        },
        '/repo'
      )
    ).toBe('18.0.1');
  });

  it('falls back to the last known pre-fnox-only release when the lookup fails', () => {
    expect(selectManagedWbVersion('19.0.0', false, () => {}, '/repo')).toBe('18.0.1');
  });

  it('resolves a failed-lookup marker to a compatible release for non-fnox repositories', () => {
    expect(selectManagedWbVersion('*', false, () => '18.0.1', '/repo')).toBe('18.0.1');
    expect(selectManagedWbVersion('*', false, () => {}, '/repo')).toBe('18.0.1');
  });

  it('passes through a failed-lookup marker for fnox repositories', () => {
    expect(
      selectManagedWbVersion(
        '*',
        true,
        () => {
          throw new Error('must not be called');
        },
        '/repo'
      )
    ).toBe('*');
  });
});
