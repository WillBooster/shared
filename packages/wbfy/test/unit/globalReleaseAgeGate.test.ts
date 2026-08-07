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
  const created = newGlobalBunfigContent(undefined);
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
  const created = newGlobalBunfigContent(existing);
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
  const created = newGlobalBunfigContent(outdated);
  expect(created.match(/wbfy:start/g)).toHaveLength(1);
  expect((parseToml(created) as { install: { minimumReleaseAge: number } }).install.minimumReleaseAge).toBe(
    bunMinimumReleaseAgeSeconds
  );
});

test('keeps a key the developer appends after the managed block under [install] across runs', () => {
  const created = newGlobalBunfigContent(undefined);
  const edited = `${created}registry = "https://example.com/"\n`;
  const rerun = newGlobalBunfigContent(edited);
  const parsed = parseToml(rerun) as { install: { registry: string; minimumReleaseAge: number } };
  expect(parsed.install.registry).toBe('https://example.com/');
  expect(parsed.install.minimumReleaseAge).toBe(bunMinimumReleaseAgeSeconds);
  expect(parsed).not.toHaveProperty('registry');
});

test('replaces hand-written gate values outside the managed block with the org policy', () => {
  const bunfig = newGlobalBunfigContent(`[install]
registry = "https://example.com/"
minimumReleaseAge = 60
minimumReleaseAgeExcludes = [
  "@myorg/foo",
]
`);
  const parsedBunfig = parseToml(bunfig) as {
    install: { registry: string; minimumReleaseAge: number; minimumReleaseAgeExcludes: string[] };
  };
  expect(parsedBunfig.install.registry).toBe('https://example.com/');
  expect(parsedBunfig.install.minimumReleaseAge).toBe(bunMinimumReleaseAgeSeconds);
  expect(parsedBunfig.install.minimumReleaseAgeExcludes).not.toContain('@myorg/foo');

  const yarnrc = newGlobalYarnrcContent(`nodeLinker: node-modules
npmMinimalAgeGate: 60
npmPreapprovedPackages:
  - '@myorg/foo'
`);
  const parsedYarnrc = loadYaml(yarnrc) as {
    nodeLinker: string;
    npmMinimalAgeGate: number;
    npmPreapprovedPackages: string[];
  };
  expect(parsedYarnrc.nodeLinker).toBe('node-modules');
  expect(parsedYarnrc.npmMinimalAgeGate).toBe(bunMinimumReleaseAgeSeconds / 60);
  expect(parsedYarnrc.npmPreapprovedPackages).not.toContain('@myorg/foo');

  const npmrc = newGlobalNpmrcContent('min-release-age=1\nmin-release-age-exclude[]=@myorg/foo\n');
  expect(npmrc).toContain(`min-release-age=${bunMinimumReleaseAgeSeconds / 86_400}`);
  expect(npmrc).not.toContain('min-release-age=1\n');
  expect(npmrc).not.toContain('@myorg/foo');
});

test('removes multi-line gate values without leaving orphan lines that would corrupt the file', () => {
  // A `]` inside an item's comment must not terminate the bunfig array early.
  const bunfig = newGlobalBunfigContent(`[install]
minimumReleaseAgeExcludes = [
  "@myorg/foo", # bracket ] in comment
  "@myorg/bar",
]
registry = "https://example.com/"
`);
  const parsedBunfig = parseToml(bunfig) as { install: { registry: string; minimumReleaseAgeExcludes: string[] } };
  expect(parsedBunfig.install.registry).toBe('https://example.com/');
  expect(parsedBunfig.install.minimumReleaseAgeExcludes).not.toContain('@myorg/foo');

  // A closing bracket at the end of an item line must end the array there, not swallow the
  // following settings.
  const bunfig2 = newGlobalBunfigContent(`[install]
minimumReleaseAgeExcludes = [
  "@myorg/foo"]
registry = "https://example.com/"
cache = true
`);
  const parsedBunfig2 = parseToml(bunfig2) as { install: { registry: string; cache: boolean } };
  expect(parsedBunfig2.install.registry).toBe('https://example.com/');
  expect(parsedBunfig2.install.cache).toBe(true);
  expect(bunfig2).not.toContain('@myorg');

  // Flow sequences (including column-0 continuation lines and closing brackets), comment lines,
  // indentation-less `- ` items, and blank lines between items must all be consumed with the key.
  for (const existing of [
    'nodeLinker: node-modules\nnpmPreapprovedPackages: [\n  "@myorg/foo",\n  "@myorg/bar"\n]\nenableGlobalCache: true\n',
    'nodeLinker: node-modules\nnpmPreapprovedPackages: [\n"@myorg/foo"]\nenableGlobalCache: true\n',
    'nodeLinker: node-modules\nnpmPreapprovedPackages:\n# approved packages\n- "@myorg/foo"\nenableGlobalCache: true\n',
    'nodeLinker: node-modules\nnpmPreapprovedPackages:\n  - "@myorg/foo"\n\n  - "@myorg/bar"\nenableGlobalCache: true\n',
  ]) {
    const yarnrc = newGlobalYarnrcContent(existing);
    const parsed = loadYaml(yarnrc) as { nodeLinker: string; enableGlobalCache: boolean };
    expect(parsed.nodeLinker).toBe('node-modules');
    expect(parsed.enableGlobalCache).toBe(true);
    expect(yarnrc).not.toContain('@myorg');
    expect(newGlobalYarnrcContent(yarnrc)).toBe(yarnrc);
  }

  // The consumption must stop at the next top-level key so following settings (e.g. credentials
  // under npmRegistries) survive.
  const yarnrcWithCreds = newGlobalYarnrcContent(
    "npmPreapprovedPackages:\n  - '@myorg/foo'\nnpmRegistries:\n  //npm.pkg.github.com:\n    npmAuthToken: SECRET_TOKEN\n"
  );
  expect(yarnrcWithCreds).toContain('SECRET_TOKEN');
  expect(loadYaml(yarnrcWithCreds)).toHaveProperty('npmRegistries');

  // A comment right before the next key documents that key, not the removed value; keep it.
  const yarnrcWithComment = newGlobalYarnrcContent(
    'npmPreapprovedPackages:\n  - "@myorg/foo"\n# Keep the global cache enabled for offline work.\nenableGlobalCache: true\n'
  );
  expect(yarnrcWithComment).toContain('# Keep the global cache enabled for offline work.');
  expect(yarnrcWithComment).not.toContain('@myorg');
});

test('removes quoted gate keys and treats backslashes in literal strings literally', () => {
  // TOML and YAML allow quoting a key; the quoted spellings are the same semantic key and must be
  // removed to avoid a duplicate definition with the managed block.
  const bunfig = newGlobalBunfigContent(`[install]
'minimumReleaseAge' = 60
registry = "https://example.com/"
`);
  const parsedBunfig = parseToml(bunfig) as { install: { registry: string; minimumReleaseAge: number } };
  expect(parsedBunfig.install.registry).toBe('https://example.com/');
  expect(parsedBunfig.install.minimumReleaseAge).toBe(bunMinimumReleaseAgeSeconds);

  const yarnrc = newGlobalYarnrcContent(`"npmMinimalAgeGate": 60
nodeLinker: node-modules
`);
  const parsedYarnrc = loadYaml(yarnrc) as { nodeLinker: string; npmMinimalAgeGate: number };
  expect(parsedYarnrc.nodeLinker).toBe('node-modules');
  expect(parsedYarnrc.npmMinimalAgeGate).toBe(bunMinimumReleaseAgeSeconds / 60);

  // In TOML literal strings and YAML single-quoted scalars a backslash is literal, so `'foo\']`
  // still closes the array on that line and the following settings must survive.
  const bunfig2 = newGlobalBunfigContent(`[install]
minimumReleaseAgeExcludes = [
  'foo\\']
registry = "https://example.com/"
cache = true
`);
  const parsedBunfig2 = parseToml(bunfig2) as { install: { registry: string; cache: boolean } };
  expect(parsedBunfig2.install.registry).toBe('https://example.com/');
  expect(parsedBunfig2.install.cache).toBe(true);

  const yarnrc2 = newGlobalYarnrcContent(`nodeLinker: node-modules
npmPreapprovedPackages: [
  'foo\\']
enableGlobalCache: true
`);
  const parsedYarnrc2 = loadYaml(yarnrc2) as { nodeLinker: string; enableGlobalCache: boolean };
  expect(parsedYarnrc2.nodeLinker).toBe('node-modules');
  expect(parsedYarnrc2.enableGlobalCache).toBe(true);

  // An anchor before a flow collection must still be recognized as a flow value.
  const yarnrc3 = newGlobalYarnrcContent(`npmPreapprovedPackages: &approved [
  '@myorg/foo',
]
enableGlobalCache: true
`);
  const parsedYarnrc3 = loadYaml(yarnrc3) as { enableGlobalCache: boolean };
  expect(parsedYarnrc3.enableGlobalCache).toBe(true);
  expect(yarnrc3).not.toContain('@myorg');
});

test('normalizes CRLF files and still removes hand-written gate keys', () => {
  const bunfig = newGlobalBunfigContent('[install]\r\nminimumReleaseAge = 60\r\nregistry = "https://example.com/"\r\n');
  const parsedBunfig = parseToml(bunfig) as { install: { registry: string; minimumReleaseAge: number } };
  expect(parsedBunfig.install.registry).toBe('https://example.com/');
  expect(parsedBunfig.install.minimumReleaseAge).toBe(bunMinimumReleaseAgeSeconds);

  const yarnrc = newGlobalYarnrcContent('npmMinimalAgeGate: 60\r\nnodeLinker: node-modules\r\n');
  const parsedYarnrc = loadYaml(yarnrc) as { nodeLinker: string; npmMinimalAgeGate: number };
  expect(parsedYarnrc.nodeLinker).toBe('node-modules');
  expect(parsedYarnrc.npmMinimalAgeGate).toBe(bunMinimumReleaseAgeSeconds / 60);
});

test('never swallows content after a flow value whose brackets never balance', () => {
  const yarnrc = newGlobalYarnrcContent(`npmPreapprovedPackages: [
  '@myorg/foo'
npmRegistries:
  //npm.pkg.github.com:
    npmAuthToken: SECRET_TOKEN
`);
  expect(yarnrc).toContain('SECRET_TOKEN');

  const bunfig = newGlobalBunfigContent(`[install]
minimumReleaseAgeExcludes = [
  "a"
registry = "https://example.com/"
ca = "MY-CERT"
`);
  expect(bunfig).toContain('registry = "https://example.com/"');
  expect(bunfig).toContain('ca = "MY-CERT"');
});

test('appends the gate even to files with broken syntax, preserving their content', () => {
  const bunfig = newGlobalBunfigContent('[install\nbroken');
  expect(bunfig).toContain('[install\nbroken');
  expect(bunfig).toContain('# wbfy:start release-age-gate');

  const yarnrc = newGlobalYarnrcContent('foo: [broken\n');
  expect(yarnrc).toContain('foo: [broken');
  expect(yarnrc).toContain('npmMinimalAgeGate:');
});

test('yarnrc gate uses minutes and preserves user settings', () => {
  const created = newGlobalYarnrcContent('nodeLinker: node-modules\n');
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
  const created = newGlobalNpmrcContent('//registry.npmjs.org/:_authToken=secret\n');
  expect(created).toContain('//registry.npmjs.org/:_authToken=secret');
  expect(created).toContain(`min-release-age=${bunMinimumReleaseAgeSeconds / 86_400}`);
  expect(created).toContain('min-release-age-exclude[]=@willbooster/wb');
});
