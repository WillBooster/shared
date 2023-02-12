import { describe, expect, it } from 'vitest';

import { buildIfNeeded, canSkipBuild } from '../src/commands/buildIfNeeded.js';

describe('canSkip', () => {
  it('app', async () => {
    expect(await buildIfNeeded('test-fixtures/app')).toBe(true);
  });
});
