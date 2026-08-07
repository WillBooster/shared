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
    // Re-running on its own output must be a no-op.
    expect(newContent(created)).toBe(created);
  }
  const bunfig = parseToml(newGlobalBunfigContent(undefined)) as {
    install: { minimumReleaseAge: number; minimumReleaseAgeExcludes: string[] };
  };
  expect(bunfig.install.minimumReleaseAge).toBe(bunMinimumReleaseAgeSeconds);
  expect(bunfig.install.minimumReleaseAgeExcludes).toContain('@willbooster/wb');

  const yarnrc = loadYaml(newGlobalYarnrcContent(undefined)) as {
    npmMinimalAgeGate: number;
    npmPreapprovedPackages: string[];
  };
  expect(yarnrc.npmMinimalAgeGate).toBe(bunMinimumReleaseAgeSeconds / 60);
  expect(yarnrc.npmPreapprovedPackages).toContain('@willbooster/wb');

  const npmrc = newGlobalNpmrcContent(undefined);
  expect(npmrc).toContain(`min-release-age=${bunMinimumReleaseAgeSeconds / 86_400}`);
  expect(npmrc).toContain('min-release-age-exclude[]=@willbooster/wb');
});

test('preserves existing parsed settings while forcing the gate over any hand-written value', () => {
  const bunfig = newGlobalBunfigContent(`telemetry = false
# a comment that must disappear
[install]
registry = "https://example.com/"
'minimumReleaseAge' = 60
minimumReleaseAgeExcludes = ["@myorg/foo"]

[install.scopes]
myorg = "https://example.com/myorg/"
`);
  const parsedBunfig = parseToml(bunfig) as {
    telemetry: boolean;
    install: {
      registry: string;
      minimumReleaseAge: number;
      minimumReleaseAgeExcludes: string[];
      scopes: Record<string, string>;
    };
  };
  expect(parsedBunfig.telemetry).toBe(false);
  expect(parsedBunfig.install.registry).toBe('https://example.com/');
  expect(parsedBunfig.install.scopes['myorg']).toBe('https://example.com/myorg/');
  expect(parsedBunfig.install.minimumReleaseAge).toBe(bunMinimumReleaseAgeSeconds);
  expect(parsedBunfig.install.minimumReleaseAgeExcludes).not.toContain('@myorg/foo');
  expect(bunfig).not.toContain('#');
  expect(newGlobalBunfigContent(bunfig)).toBe(bunfig);

  const yarnrc = newGlobalYarnrcContent(`nodeLinker: node-modules
npmMinimalAgeGate: 60
npmPreapprovedPackages: [
  '@myorg/foo',
]
npmRegistries:
  //npm.pkg.github.com:
    npmAuthToken: SECRET_TOKEN
`);
  const parsedYarnrc = loadYaml(yarnrc) as {
    nodeLinker: string;
    npmMinimalAgeGate: number;
    npmPreapprovedPackages: string[];
    npmRegistries: Record<string, { npmAuthToken: string }>;
  };
  expect(parsedYarnrc.nodeLinker).toBe('node-modules');
  expect(parsedYarnrc.npmMinimalAgeGate).toBe(bunMinimumReleaseAgeSeconds / 60);
  expect(parsedYarnrc.npmPreapprovedPackages).not.toContain('@myorg/foo');
  expect(parsedYarnrc.npmRegistries['//npm.pkg.github.com']?.npmAuthToken).toBe('SECRET_TOKEN');
  expect(newGlobalYarnrcContent(yarnrc)).toBe(yarnrc);

  // Yarn-schema parity (FAILSAFE_SCHEMA + json): a digit-only credential keeps its exact text
  // instead of being coerced to a number, and duplicate keys — which Yarn accepts, last wins — do
  // not cause a wholesale replacement.
  const numericTokenYarnrc = newGlobalYarnrcContent(`nodeLinker: pnp
npmRegistries:
  //npm.pkg.github.com:
    npmAuthToken: 0123456789012345678901234567890
nodeLinker: node-modules
`);
  expect(numericTokenYarnrc).toContain('0123456789012345678901234567890');
  const parsedNumericTokenYarnrc = loadYaml(numericTokenYarnrc) as {
    nodeLinker: string;
    npmRegistries: Record<string, { npmAuthToken: string }>;
  };
  expect(parsedNumericTokenYarnrc.nodeLinker).toBe('node-modules');
  expect(parsedNumericTokenYarnrc.npmRegistries['//npm.pkg.github.com']?.npmAuthToken).toBe(
    '0123456789012345678901234567890'
  );
  expect(newGlobalYarnrcContent(numericTokenYarnrc)).toBe(numericTokenYarnrc);

  const npmrc = newGlobalNpmrcContent(
    '//registry.npmjs.org/:_authToken=secret\nmin-release-age=1\nmin-release-age-exclude[]=@myorg/foo\n'
  );
  expect(npmrc).toContain('//registry.npmjs.org/:_authToken=secret');
  expect(npmrc).toContain(`min-release-age=${bunMinimumReleaseAgeSeconds / 86_400}`);
  expect(npmrc).not.toContain('min-release-age=1\n');
  expect(npmrc).not.toContain('@myorg/foo');
  expect(newGlobalNpmrcContent(npmrc)).toBe(npmrc);
});

test('replaces files that do not parse into a top-level table with the org-managed content', () => {
  for (const [newContent, parse, broken, leftover] of [
    [newGlobalBunfigContent, parseToml, '[install\nbroken', 'broken'],
    [newGlobalYarnrcContent, loadYaml, 'foo: [broken\n', 'broken'],
    [newGlobalYarnrcContent, loadYaml, 'just a scalar document\n', 'scalar'],
    // A lone timestamp scalar: the parser returns a non-plain object (or string), never a mapping.
    [newGlobalYarnrcContent, loadYaml, '2026-01-01T00:00:00Z\n', '2026-01-01'],
  ] as const) {
    const created = newContent(broken);
    expect(created).not.toContain(leftover);
    expect(parse(created)).toBeTruthy();
  }
});

test('migrates legacy marker-based files without duplicating the gate', () => {
  const legacyBunfig = `[install]
# wbfy:start release-age-gate
minimumReleaseAge = 1 # stale
minimumReleaseAgeExcludes = [
    "@willbooster/wb",
]
# wbfy:end release-age-gate
registry = "https://example.com/"
`;
  const bunfig = newGlobalBunfigContent(legacyBunfig);
  expect(bunfig).not.toContain('wbfy:start');
  expect(bunfig.match(/minimumReleaseAge =/g)).toHaveLength(1);
  const parsedBunfig = parseToml(bunfig) as { install: { registry: string; minimumReleaseAge: number } };
  expect(parsedBunfig.install.registry).toBe('https://example.com/');
  expect(parsedBunfig.install.minimumReleaseAge).toBe(bunMinimumReleaseAgeSeconds);

  const legacyNpmrc = `//registry.npmjs.org/:_authToken=secret
# wbfy:start release-age-gate
min-release-age=1
min-release-age-exclude[]=@willbooster/wb
# wbfy:end release-age-gate
`;
  const npmrc = newGlobalNpmrcContent(legacyNpmrc);
  expect(npmrc).not.toContain('wbfy:start');
  expect(npmrc).toContain('//registry.npmjs.org/:_authToken=secret');
  expect(npmrc.match(/^min-release-age=/gm)).toHaveLength(1);
});
