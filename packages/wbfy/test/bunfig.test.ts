import { expect, test } from 'vitest';

import { extractRawTestSections } from '../src/generators/bunfig.js';

test('preserves [test] sections with their comments and drops other sections', () => {
  const existingContent = `env = false
telemetry = false

[run]
bun = true

[test]
# The production db client targets Cloudflare D1; unit tests swap it for a
# local SQLite client before any test module loads.
preload = ["./test/unit/preloadDbClient.ts"]

[install]
exact = true
`;

  expect(extractRawTestSections(existingContent)).toBe(`[test]
# The production db client targets Cloudflare D1; unit tests swap it for a
# local SQLite client before any test module loads.
preload = ["./test/unit/preloadDbClient.ts"]

`);
});

test('returns an empty string when there is no [test] section', () => {
  expect(extractRawTestSections(undefined)).toBe('');
  expect(extractRawTestSections('env = false\n\n[install]\nexact = true\n')).toBe('');
});
