import { load as loadYaml } from 'js-yaml';
import { parse as parseToml } from 'smol-toml';
import { expect, test } from 'vitest';

import { bunMinimumReleaseAgeSeconds } from '../../src/generators/bunfig.js';
import {
  newGlobalBunfigContent,
  newGlobalNpmrcContent,
  newGlobalYarnrcContent,
} from '../../src/generators/globalReleaseAgeGate.js';

test('creates each global config from scratch and stays idempotent', () => {
  for (const newContent of [newGlobalBunfigContent, newGlobalYarnrcContent, newGlobalNpmrcContent]) {
    const created = newContent(undefined);
    expect(created).toContain('# wbfy:start release-age-gate');
    // Re-running on its own output must be a no-op, and must never duplicate the block.
    expect(newContent(created)).toBe(created);
  }
});

test('generated bunfig content parses and carries the gate', () => {
  const created = newGlobalBunfigContent(undefined) as string;
  const parsed = parseToml(created) as { install: { minimumReleaseAge: number; minimumReleaseAgeExcludes: string[] } };
  expect(parsed.install.minimumReleaseAge).toBe(bunMinimumReleaseAgeSeconds);
  expect(parsed.install.minimumReleaseAgeExcludes).toContain('@willbooster/wb');
});

test('inserts the bunfig gate into an existing [install] section and preserves user content', () => {
  const existing = `telemetry = false

[install]
registry = "https://example.com/"

[install.scopes]
myorg = "https://example.com/myorg/"
`;
  const created = newGlobalBunfigContent(existing) as string;
  const parsed = parseToml(created) as {
    telemetry: boolean;
    install: { registry: string; minimumReleaseAge: number; scopes: Record<string, string> };
  };
  expect(parsed.telemetry).toBe(false);
  expect(parsed.install.registry).toBe('https://example.com/');
  expect(parsed.install.scopes['myorg']).toBe('https://example.com/myorg/');
  expect(parsed.install.minimumReleaseAge).toBe(bunMinimumReleaseAgeSeconds);
  expect(newGlobalBunfigContent(created)).toBe(created);
});

test('replaces an outdated managed block instead of stacking a second one', () => {
  const outdated = `# wbfy:start release-age-gate
[install]
minimumReleaseAge = 1 # stale
# wbfy:end release-age-gate
`;
  const created = newGlobalBunfigContent(outdated) as string;
  expect(created.match(/wbfy:start/g)).toHaveLength(1);
  expect((parseToml(created) as { install: { minimumReleaseAge: number } }).install.minimumReleaseAge).toBe(
    bunMinimumReleaseAgeSeconds
  );
});

test('leaves files with a hand-written gate or broken syntax untouched', () => {
  expect(newGlobalBunfigContent('[install]\nminimumReleaseAge = 60\n')).toBeUndefined();
  expect(newGlobalBunfigContent('[install\nbroken')).toBeUndefined();
  expect(newGlobalYarnrcContent('npmMinimalAgeGate: 60\n')).toBeUndefined();
  expect(newGlobalYarnrcContent('foo: [broken\n')).toBeUndefined();
  expect(newGlobalNpmrcContent('min-release-age=1\n')).toBeUndefined();
});

test('yarnrc gate uses minutes and preserves user settings', () => {
  const created = newGlobalYarnrcContent('nodeLinker: node-modules\n') as string;
  const parsed = loadYaml(created) as {
    nodeLinker: string;
    npmMinimalAgeGate: number;
    npmPreapprovedPackages: string[];
  };
  expect(parsed.nodeLinker).toBe('node-modules');
  expect(parsed.npmMinimalAgeGate).toBe(bunMinimumReleaseAgeSeconds / 60);
  expect(parsed.npmPreapprovedPackages).toContain('@willbooster/wb');
});

test('npmrc gate preserves unrelated lines such as credentials', () => {
  const created = newGlobalNpmrcContent('//registry.npmjs.org/:_authToken=secret\n') as string;
  expect(created).toContain('//registry.npmjs.org/:_authToken=secret');
  expect(created).toContain(`min-release-age=${bunMinimumReleaseAgeSeconds / 86_400}`);
});
