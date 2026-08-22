import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { expect, test } from 'vitest';
import type { PackageJson } from 'type-fest';

import { generatePackageJson } from '../../src/generators/packageJson.js';
import { createConfig } from '../helpers/testConfig.js';

interface GeneratedPackageJson {
  dependencies?: Record<string, string | undefined>;
  devDependencies?: Record<string, string | undefined>;
  license?: string;
  name?: string;
  peerDependencies?: Record<string, string | undefined>;
  private?: boolean;
  publishConfig?: { access?: string; registry?: string };
  scripts?: Record<string, string | undefined>;
  trustedDependencies?: string[];
}

const genI18nTsDepending = {
  ...createConfig().depending,
  genI18nTs: true,
};

test('does not restore missing default gen-i18n-ts script with managed wb gen-code postinstall', async () => {
  const packageJson = await generatePackageJsonFrom(
    {
      dependencies: {
        'gen-i18n-ts': '4.0.6',
      },
      scripts: {},
    },
    { depending: genI18nTsDepending, isRoot: true },
    { createI18nDir: true }
  );

  expect(packageJson.scripts).toMatchObject({
    cleanup: 'bun wb lint --fix --format',
    'gen-code': 'bun wb gen-code',
    postinstall: 'bun wb gen-code',
  });
  expect(packageJson.scripts?.['gen-i18n-ts']).toBeUndefined();
});

test('keeps custom gen-i18n-ts scripts while adding wb gen-code', async () => {
  const packageJson = await generatePackageJsonFrom(
    {
      scripts: {
        'gen-i18n-ts': 'gen-i18n-ts -i locales -o src/i18n.ts -d en-US',
      },
      dependencies: {
        'gen-i18n-ts': '4.0.6',
      },
    },
    { depending: genI18nTsDepending, isRoot: true },
    { createI18nDir: true }
  );

  expect(packageJson.scripts).toMatchObject({
    'gen-code': 'bun wb gen-code',
    'gen-i18n-ts': 'gen-i18n-ts -i locales -o src/i18n.ts -d en-US',
  });
});

// The same shapes but mixing in the project's OWN command. The parser cannot preserve it across the unsupported
// shell syntax, so the script is left alone rather than silently losing that command.
test('leaves an unparseable postinstall carrying a project command alone', async () => {
  const postinstall = 'patch-package > /dev/null && bun run gen-i18n-ts';
  const packageJson = await generatePackageJsonFrom(
    { scripts: { postinstall }, dependencies: { 'gen-i18n-ts': '4.0.6' } },
    { depending: genI18nTsDepending },
    { createI18nDir: true }
  );

  expect(packageJson.scripts?.postinstall).toBe(postinstall);
});

test('keeps build-ts as a runtime dependency when prisma seed uses it', async () => {
  const oldBuildTsVersion = '0.0.1';
  const packageJson = await generatePackageJsonFrom({
    devDependencies: {
      'build-ts': oldBuildTsVersion,
    },
    dependencies: {
      'build-ts': oldBuildTsVersion,
    },
    prisma: {
      seed: 'build-ts run prisma/seed.ts',
    },
    scripts: {},
  });

  expect(packageJson.dependencies?.['build-ts']).toMatch(/^\d+\.\d+\.\d+/u);
  expect(packageJson.dependencies?.['build-ts']).not.toBe(oldBuildTsVersion);
  expect(packageJson.devDependencies?.['build-ts']).toBeUndefined();
});

test('keeps build-ts as a runtime dependency when seed script uses it', async () => {
  const oldBuildTsVersion = '0.0.1';
  const packageJson = await generatePackageJsonFrom({
    devDependencies: {
      'build-ts': oldBuildTsVersion,
    },
    scripts: {
      seed: 'build-ts run db/seed.ts',
    },
  });

  expect(packageJson.dependencies?.['build-ts']).toMatch(/^\d+\.\d+\.\d+/u);
  expect(packageJson.dependencies?.['build-ts']).not.toBe(oldBuildTsVersion);
  expect(packageJson.devDependencies?.['build-ts']).toBeUndefined();
});

test('keeps build-ts as a dev dependency when seed script uses a different hyphenated command', async () => {
  const oldBuildTsVersion = '0.0.1';
  const packageJson = await generatePackageJsonFrom({
    devDependencies: {
      'build-ts': oldBuildTsVersion,
    },
    scripts: {
      seed: 'build-ts-compiler run db/seed.ts && my-build-ts run db/seed.ts',
    },
  });

  expect(packageJson.dependencies?.['build-ts']).toBeUndefined();
  expect(packageJson.devDependencies?.['build-ts']).toMatch(/^\d+\.\d+\.\d+/u);
  expect(packageJson.devDependencies?.['build-ts']).not.toBe(oldBuildTsVersion);
});

test('keeps wb as a runtime dependency when postinstall uses it', async () => {
  const oldWbVersion = '0.0.1';
  const packageJson = await generatePackageJsonFrom({
    devDependencies: {
      '@willbooster/wb': oldWbVersion,
    },
    scripts: {
      'gen-code': 'wb gen-code',
      postinstall: 'wb gen-code',
    },
  });

  expect(packageJson.dependencies?.['@willbooster/wb']).toMatch(/^\d+\.\d+\.\d+/u);
  expect(packageJson.dependencies?.['@willbooster/wb']).not.toBe(oldWbVersion);
});

test('keeps wb as a runtime dependency when db-migrate uses it', async () => {
  const oldWbVersion = '0.0.1';
  const packageJson = await generatePackageJsonFrom({
    dependencies: {
      '@willbooster/wb': oldWbVersion,
    },
    scripts: {
      'db-migrate': 'bun wb db migrate --check-idempotency',
    },
  });

  expect(packageJson.dependencies?.['@willbooster/wb']).toMatch(/^\d+\.\d+\.\d+/u);
  expect(packageJson.dependencies?.['@willbooster/wb']).not.toBe(oldWbVersion);
  expect(packageJson.devDependencies?.['@willbooster/wb']).toBeUndefined();
});

test('preserves workspace: dependency specifiers in public packages', async () => {
  const packageJson = await generatePackageJsonFrom(
    {
      devDependencies: {
        '@willbooster/wb': 'workspace:^14.0.0',
      },
      workspaces: ['packages/*'],
    },
    { isRoot: true },
    {
      files: {
        'packages/wb/package.json': JSON.stringify({ name: '@willbooster/wb' }),
      },
    }
  );

  expect(packageJson.devDependencies?.['@willbooster/wb']).toBe('workspace:^14.0.0');
});

test('updates non-workspace dependency specifiers in public packages', async () => {
  const packageJson = await generatePackageJsonFrom(
    {
      devDependencies: {
        '@willbooster/wb': '0.0.1',
      },
      workspaces: ['packages/*'],
    },
    { isRoot: true },
    {
      files: {
        'packages/wb/package.json': JSON.stringify({ name: '@willbooster/wb' }),
      },
    }
  );

  expect(packageJson.devDependencies?.['@willbooster/wb']).toMatch(/^\d+\.\d+\.\d+$/u);
  expect(packageJson.devDependencies?.['@willbooster/wb']).not.toBe('0.0.1');
});

test('uses stable age-gated versions for generated dependencies when skipping installs', async () => {
  const packageJson = await generatePackageJsonFrom({}, { doesContainJava: true });

  expect(packageJson.devDependencies?.prettier).toMatch(/^\d+\.\d+\.\d+$/u);
});

test('keeps prettier for packages that import it as a runtime library but drops it otherwise', async () => {
  const importing = await generatePackageJsonFrom(
    { dependencies: { prettier: '3.9.5' } },
    { depending: { ...createConfig().depending, prettierRuntime: true } }
  );
  expect(importing.dependencies?.prettier).toBe('3.9.5');

  const notImporting = await generatePackageJsonFrom({ dependencies: { prettier: '3.9.5' } });
  expect(notImporting.dependencies?.prettier).toBeUndefined();
});

test('keeps and restores prettier when a runtime prettier plugin is declared', async () => {
  const retainedPackageJson = await generatePackageJsonFrom({
    dependencies: {
      prettier: '3.0.0',
      'prettier-plugin-organize-attributes': '1.0.0',
    },
  });
  expect(retainedPackageJson.dependencies?.prettier).toBe('3.0.0');

  const missingPrettierPackageJson = {
    dependencies: {
      'prettier-plugin-organize-attributes': '1.0.0',
    },
  };
  const restoredPackageJson = await generatePackageJsonFrom(missingPrettierPackageJson);
  const restoredJavaPackageJson = await generatePackageJsonFrom(missingPrettierPackageJson, {
    doesContainJava: true,
  });

  expect(restoredPackageJson.dependencies?.prettier).toMatch(/^\d+\.\d+\.\d+$/u);
  expect(restoredPackageJson.dependencies?.['prettier-plugin-organize-attributes']).toBe('1.0.0');
  expect(restoredJavaPackageJson.dependencies?.prettier).toBe(restoredPackageJson.dependencies?.prettier);
});

// `wb gen-code` generates worker-configuration.d.ts itself, so wbfy no longer weaves `wrangler types` into the
// managed scripts: a Cloudflare package normalizes to `bun wb gen-code` like any other.
test('normalizes managed scripts of a Cloudflare project to wb gen-code', async () => {
  const wranglerPackageJson = { devDependencies: { wrangler: '4.69.0' } };
  const packageJson = await generatePackageJsonFrom(
    { scripts: {}, ...wranglerPackageJson },
    {
      depending: genI18nTsDepending,
      isCloudflare: true,
      doesContainWranglerConfig: true,
      packageJson: wranglerPackageJson,
    },
    { createI18nDir: true }
  );

  expect(packageJson.scripts).toMatchObject({
    'gen-code': 'bun wb gen-code',
    postinstall: 'bun wb gen-code',
  });
});

test.each([
  ['a referenced alias', { 'gen-types': 'wrangler types', build: 'bun run gen-types && vite build' }],
  ['an npm run-script alias reference', { 'gen-types': 'wrangler types', build: 'npm run-script gen-types' }],
  ['a quoted alias reference', { 'gen-types': 'wrangler types', build: 'bun run "gen-types"' }],
  [
    'an alias reference after an unparseable command',
    { 'gen-types': 'wrangler types', build: 'patch-package > /dev/null && bun run gen-types' },
  ],
  ['a compound alias', { 'gen-types': 'wrangler types && echo custom', postinstall: 'bun run gen-types' }],
  ['an arbitrary generator name', { 'types:worker': 'wrangler types --strict-vars=false' }],
  ['an arbitrary generator name with extra whitespace', { 'types:worker': 'wrangler  types --strict-vars=false' }],
  ['an unsupported runner', { 'gen-types': 'npm exec wrangler types --strict-vars=false' }],
  ['a yarn binary runner', { postinstall: 'yarn wrangler types --strict-vars=false' }],
  ['a bun binary runner', { postinstall: 'bun wrangler types --strict-vars=false' }],
  ['a pnpm binary runner', { postinstall: 'pnpm wrangler types --strict-vars=false' }],
  ['an npx runner option', { postinstall: 'npx -y wrangler types --strict-vars=false' }],
  ['a bunx runner option', { postinstall: 'bunx --bun wrangler types --strict-vars=false' }],
  ['an npm exec package option', { postinstall: 'npm exec --package wrangler -- wrangler types --path=src/env.d.ts' }],
  ['a bun run binary runner', { postinstall: 'bun run wrangler types --path=src/env.d.ts' }],
  ['an environment-prefixed generator', { 'gen-types': 'NODE_ENV=test wrangler types' }],
  ['a global config flag', { 'gen-types': 'wrangler --config=wrangler.jsonc types' }],
  ['a short global config flag', { 'gen-types': 'wrangler -c wrangler.jsonc types' }],
  ['a global environment flag', { 'gen-types': 'wrangler --env=staging types' }],
  ['a global profile flag', { 'gen-types': 'wrangler --profile staging types' }],
  ['a global boolean flag', { 'gen-types': 'wrangler --install-skills types' }],
  ['an experimental global flag', { 'gen-types': 'wrangler --experimental-provision=false types' }],
  ['an experimental alias flag', { 'gen-types': 'wrangler --x-auto-create=false types' }],
  ['a version-qualified executable', { 'gen-types': 'npx wrangler@4.107.0 types' }],
  ['a quoted global option value', { 'gen-types': 'wrangler --config "configs/worker config.jsonc" types' }],
  ['a quoted equals-form option value', { 'gen-types': "wrangler --config='configs/worker config.jsonc' types" }],
  ['an escaped option value', { 'gen-types': String.raw`wrangler --config configs/worker\ config.jsonc types` }],
  ['a subcommand config flag', { 'gen-types': 'wrangler types --config=wrangler.other.jsonc' }],
  ['a short subcommand config flag', { 'gen-types': 'wrangler types -c wrangler.other.jsonc' }],
  ['a positional output path after a flag', { postinstall: 'wrangler types --strict-vars=false src/env.d.ts' }],
  ['an equals-form output path', { postinstall: 'wrangler types --path=src/env.d.ts' }],
  ['an environment', { postinstall: 'wrangler types --env=staging' }],
  ['a custom interface', { postinstall: 'wrangler types --env-interface=CloudflareEnv' }],
  ['a custom working directory', { postinstall: 'wrangler types --cwd packages/worker' }],
  ['a global custom working directory', { postinstall: 'wrangler --cwd packages/worker types' }],
  ['a check', { 'check-types': 'wrangler types --check' }],
  ['an equals-form check', { 'gen-types': 'wrangler types --check=true' }],
  ['a divergent check', { 'check-types': 'wrangler types --check --strict-vars=false' }],
  ['a flagged alias reference', { 'gen-types': 'wrangler types', build: 'bun --bun run gen-types' }],
  ['an unparseable postinstall alias', { 'gen-types': 'wrangler types', postinstall: 'bun run gen-types > /dev/null' }],
  ['a flagged postinstall alias', { 'gen-types': 'wrangler types', postinstall: 'npm --silent run-script gen-types' }],
  ['a joined redirection', { postinstall: 'wrangler types>/dev/null' }],
  ['a joined alias redirection', { 'gen-types': 'wrangler types', postinstall: 'bun run gen-types>/dev/null' }],
  ['unsupported shell syntax', { postinstall: 'cd sub && wrangler types' }],
  ['eval indirection', { postinstall: 'eval wrangler types' }],
  ['shell indirection', { postinstall: "sh -c 'wrangler types'" }],
  ['combined shell-option indirection', { postinstall: 'echo before && sh -lc "wrangler types"' }],
  ['a quoted executable', { postinstall: '"wrangler" types' }],
  ['an if command', { postinstall: 'if wrangler types; then echo done; fi' }],
  ['a subshell command', { postinstall: '(wrangler types)' }],
  ['a newline-separated command', { postinstall: 'echo before\nwrangler types' }],
  ['a case branch command', { postinstall: 'case x in x) wrangler types;; esac' }],
  ['a timed command', { postinstall: 'time wrangler types' }],
  ['a command-env prefix', { postinstall: 'command env wrangler types' }],
  ['a backtick substitution', { postinstall: 'echo `wrangler types`' }],
  ['a quoted command substitution', { postinstall: 'echo "$(wrangler types)"' }],
  ['a shell separator before a payload', { postinstall: "sh -c -- 'wrangler types'" }],
  ['a combined shell option before a payload', { postinstall: "bash -lc -- 'wrangler types'" }],
  ['an interpolated heredoc body', { postinstall: 'cat <<EOF\n$(wrangler types)\nEOF' }],
  ['a substitution after a quoted hash', { postinstall: 'echo "a # b $(wrangler types)"' }],
  ['a command after a quoted fake heredoc', { postinstall: 'echo "a << b"\nwrangler types' }],
  ['a command after an arithmetic shift', { postinstall: 'echo $((1 << 2))\nwrangler types' }],
  ['a textual mention', { help: 'echo wrangler types' }],
  ['a textual gen-types mention', { 'gen-types': 'wrangler types', help: 'echo gen-types' }],
  ['a shell payload that prints the words', { help: 'sh -c "echo wrangler types"' }],
  ['a heredoc containing the words', { help: "cat <<'EOF'\nwrangler types\nEOF" }],
  ['a single-quoted backtick', { help: "node -e 'console.log(`wrangler types`)'" }],
  ['a redirection target', { help: 'echo ok > "wrangler types"' }],
  ['a commented substitution', { help: 'echo ok # `wrangler types`' }],
  ['a shell payload after a separator', { help: 'sh -c -- "echo wrangler types"' }],
  [
    'a cross-package generator without a local config',
    { postinstall: 'wrangler types --config packages/app/wrangler.jsonc' },
    false,
  ],
])(
  'rejects %s instead of partially normalizing it',
  async (_description, scripts, doesContainWranglerConfig = true) => {
    const wranglerPackageJson = { devDependencies: { wrangler: '4.69.0' }, scripts };
    const packageJson = await generatePackageJsonFrom(
      { ...wranglerPackageJson },
      {
        isCloudflare: true,
        doesContainWranglerConfig,
        packageJson: wranglerPackageJson,
      }
    );

    expect(packageJson.scripts).toEqual(scripts);
  }
);

test('does not treat an unrelated Wrangler command argument as the types subcommand', async () => {
  const scripts = { deploy: 'wrangler deploy types' };
  const wranglerPackageJson = { devDependencies: { wrangler: '4.69.0' }, scripts };
  const packageJson = await generatePackageJsonFrom(
    { ...wranglerPackageJson },
    {
      isCloudflare: true,
      doesContainWranglerConfig: true,
      packageJson: wranglerPackageJson,
    }
  );

  expect(packageJson.scripts).toMatchObject({ deploy: 'wrangler deploy types', postinstall: 'bun wb gen-code' });
});

test.each([
  ['a quoted fake heredoc marker', 'echo "a << b"\necho done'],
  ['an arithmetic shift', 'echo $((1 << 2))'],
])('ignores %s without the literal worker-types command', async (_description, help) => {
  const scripts = { help };
  const wranglerPackageJson = { devDependencies: { wrangler: '4.69.0' }, scripts };
  const packageJson = await generatePackageJsonFrom(
    { ...wranglerPackageJson },
    { isCloudflare: true, doesContainWranglerConfig: true, packageJson: wranglerPackageJson }
  );

  expect(packageJson.scripts?.help).toBe(help);
  expect(packageJson.scripts?.postinstall).toBe('bun wb gen-code');
});

test('rejects worker type generation without a direct wrangler dependency', async () => {
  const scripts = { postinstall: 'wrangler types --strict-vars=false' };
  const packageJson = await generatePackageJsonFrom(
    { scripts },
    { isCloudflare: true, doesContainWranglerConfig: true, packageJson: { scripts } }
  );

  expect(packageJson.scripts).toEqual(scripts);
});

test.each([
  'npm run gen-code',
  'pnpm gen-code',
  'yarn run gen-code',
  'npm wb gen-code',
  'npx wb gen-code',
  'yarn wb gen-code',
])('rejects unsupported postinstall alias %s instead of duplicating generation', async (postinstall) => {
  const scripts = { 'gen-code': 'bun wb gen-code', postinstall };
  const packageJson = await generatePackageJsonFrom({ scripts }, { packageJson: { scripts } });

  expect(packageJson.scripts).toEqual(scripts);
});

// A wrapper around a CUSTOMIZED gen-code is the install-time entry point for BOTH the managed generation and the
// project's own steps. Replacing it with a bare `wb gen-code` would stop `build-assets` running on install;
// appending one would run every generator twice.
test('keeps a wrapper around a customized gen-code script', async () => {
  const packageJson = await generatePackageJsonFrom(
    {
      scripts: { 'gen-code': 'bun wb gen-code && bun run build-assets', postinstall: 'bun run gen-code' },
    },
    { depending: genI18nTsDepending },
    { createI18nDir: true }
  );

  expect(packageJson.scripts?.postinstall).toBe('bun run gen-code');
  expect(packageJson.scripts?.['gen-code']).toBe('bun wb gen-code && bun run build-assets');
});

// `wb gen-code` runs gen-i18n-ts with the package's own script or its own fixed defaults, so a direct call
// carrying custom arguments generates a DIFFERENT file and must survive.
test('preserves a customized gen-i18n-ts invocation appended to gen-code', async () => {
  const custom = 'gen-i18n-ts -i locales -o src/customI18n.ts -d en-US';
  const packageJson = await generatePackageJsonFrom(
    { scripts: { 'gen-code': `wb gen-code && ${custom}` }, dependencies: { 'gen-i18n-ts': '4.0.6' } },
    { depending: genI18nTsDepending },
    { createI18nDir: true }
  );

  expect(packageJson.scripts?.['gen-code']).toBe(`bun wb gen-code && ${custom}`);
});

// A step placed AFTER generation may consume the generated types, so the rewrite must not move it in front.
test('preserves the position of a custom step after generation', async () => {
  const packageJson = await generatePackageJsonFrom(
    {
      scripts: { 'gen-code': 'bun wb gen-code', postinstall: 'wb gen-code && bun run build-assets' },
    },
    { depending: genI18nTsDepending },
    { createI18nDir: true }
  );

  expect(packageJson.scripts?.postinstall).toBe('bun wb gen-code && bun run build-assets');
});

// `wb gen-code` also runs prisma, drizzle-kit check, and chakra typegen, so it must survive even where the
// worker-types generation is no longer wanted.
test('keeps a wb gen-code postinstall for an unmanaged worker package', async () => {
  const wranglerPackageJson = {
    devDependencies: { wrangler: '4.69.0', 'drizzle-orm': '0.44.5' },
    scripts: { postinstall: 'wb gen-code' },
  };
  const packageJson = await generatePackageJsonFrom(
    { ...wranglerPackageJson },
    { isCloudflare: true, doesContainWranglerConfig: true, packageJson: wranglerPackageJson }
  );

  expect(packageJson.scripts?.postinstall).toBe('bun wb gen-code');
});

// Silently dropping a project's own install step (e.g. applying patches) would break its install.
test('preserves custom postinstall segments', async () => {
  const packageJson = await generatePackageJsonFrom(
    { scripts: { 'gen-code': 'bun wb gen-code', postinstall: 'patch-package && bun run gen-code' } },
    { depending: genI18nTsDepending },
    { createI18nDir: true }
  );

  expect(packageJson.scripts?.postinstall).toBe('patch-package && bun wb gen-code');
});

// A project may append its own step to the managed `bun wb gen-code` (e.g. building extra deploy assets).
// Regenerating gen-code must keep that step instead of discarding it.
test('preserves project-specific steps appended to the managed gen-code script', async () => {
  const config = { depending: genI18nTsDepending };
  const expected = 'bun wb gen-code && bun wb dotenv -- build-ts run scripts/buildLessonImages.ts';
  const first = await generatePackageJsonFrom(
    { scripts: { 'gen-code': `wb gen-code && ${expected.split(' && ')[1]}` } },
    config,
    { createI18nDir: true }
  );
  expect(first.scripts?.['gen-code']).toBe(expected);

  // wbfy consumes its own output, so a second run must be a no-op.
  const second = await generatePackageJsonFrom({ scripts: { ...first.scripts } }, config, { createI18nDir: true });
  expect(second.scripts?.['gen-code']).toBe(expected);
});

// A gen-code script whose shell wbfy does not model is left to a human instead of being rewritten from a wrong parse.
test('leaves an unmodeled gen-code script alone', async () => {
  const packageJson = await generatePackageJsonFrom(
    { scripts: { 'gen-code': 'wb gen-code; tsx scripts/genRoutes.ts' } },
    { depending: genI18nTsDepending },
    { createI18nDir: true }
  );

  expect(packageJson.scripts?.['gen-code']).toBe('wb gen-code; tsx scripts/genRoutes.ts');
});

// Without a gen-code script `wb gen-code` still has to run on install, but a project-owned postinstall step may
// generate `wrangler types`' own inputs (a wrangler config, `.dev.vars`), so it keeps running first.
test('runs wb gen-code after a project postinstall that has no gen-code script', async () => {
  const wranglerPackageJson = { devDependencies: { wrangler: '4.69.0' } };
  const packageJson = await generatePackageJsonFrom(
    { scripts: { postinstall: 'node scripts/writeDevVars.js' }, ...wranglerPackageJson },
    { isCloudflare: true, doesContainWranglerConfig: true, packageJson: wranglerPackageJson }
  );

  expect(packageJson.scripts?.postinstall).toBe('node scripts/writeDevVars.js && bun wb gen-code');
  expect(packageJson.scripts?.['gen-code']).toBeUndefined();
});

// wbfy gitignores worker-configuration.d.ts only where postinstall regenerates it, so a package that
// cannot run wrangler must not gain the install-time generation either.
test.each([
  ['the package does not depend on wrangler', {}, true],
  ['the package owns no wrangler config', { devDependencies: { wrangler: '4.69.0' } }, false],
])('omits the install-time generation when %s', async (_description, wranglerPackageJson, hasConfig) => {
  const packageJson = await generatePackageJsonFrom(
    { scripts: {}, ...wranglerPackageJson },
    { isCloudflare: true, doesContainWranglerConfig: hasConfig, packageJson: wranglerPackageJson }
  );

  expect(packageJson.scripts?.postinstall).toBeUndefined();
});

// `wb gen-code` pins the `Env` inference to the committed fnox.toml key names via `wrangler types --env-file`,
// so machine-local dotenv files (which `wb start`/`wb deploy` create routinely) never affect the generated file.
// They must therefore never disable the install-time generation either: when a local `.dev.vars` flipped this
// decision, wbfy runs on dev machines re-tracked the generated file that clean-checkout runs had untracked,
// oscillating forever (ai-game-builder #684 → #746).
test('generates worker types on install despite machine-local dotenv files', async () => {
  const wranglerPackageJson = { devDependencies: { wrangler: '4.69.0' } };
  const packageJson = await generatePackageJsonFrom(
    { scripts: {}, ...wranglerPackageJson },
    { isCloudflare: true, doesContainWranglerConfig: true, packageJson: wranglerPackageJson },
    {
      files: {
        '.dev.vars': 'AUTH_SECRET=local-secret\n',
        '.env.cloudflare': 'CLOUDFLARE_API_TOKEN=x\n',
        'wrangler.jsonc': '{}',
      },
    }
  );

  expect(packageJson.scripts?.postinstall).toBe('bun wb gen-code');
});

test('keeps custom database scripts for drizzle projects', async () => {
  const packageJson = await generatePackageJsonFrom(
    {
      scripts: {
        'db-migrate': 'bun scripts/runDrizzleMigrationsToAllClients.ts',
      },
    },
    { depending: { ...createConfig().depending, drizzle: true } }
  );

  expect(packageJson.scripts).toMatchObject({
    'db-create-migration': 'bun wb db migrate-dev',
    'db-migrate': 'bun scripts/runDrizzleMigrationsToAllClients.ts',
    'db-view': 'bun wb db studio',
  });
});

test('preserves custom wrapper bodies of managed db scripts that contain a wb db call', async () => {
  const wrapperScripts = {
    'db-create-migration': 'prepare-sqlite && wb db migrate-dev',
    'db-migrate': 'for t in a b; do DATABASE_URL=$t wb prisma migrate; done',
    // oxlint-disable-next-line no-template-curly-in-string -- the shell-default form under test
    'db-view': 'prepare-sqlite && WB_ENV=${WB_ENV:-development} wb db studio',
  };
  const packageJson = await generatePackageJsonFrom(
    { scripts: wrapperScripts },
    { depending: { ...createConfig().depending, prisma: true } }
  );

  expect(packageJson.scripts).toMatchObject(wrapperScripts);
  expect(packageJson.dependencies?.['@willbooster/wb']).toMatch(/^\d+\.\d+\.\d+/u);
});

test('replaces generated db script bodies using supported Bun runner prefixes', async () => {
  const packageJson = await generatePackageJsonFrom(
    {
      scripts: {
        'db-create-migration': 'bun --bun wb prisma migrate-dev',
        'db-migrate': 'bun --bun wb prisma migrate --check-idempotency',
        'db-view': 'wb prisma studio',
      },
    },
    { depending: { ...createConfig().depending, prisma: true } }
  );

  expect(packageJson.scripts).toMatchObject({
    'db-create-migration': 'bun wb prisma migrate-dev',
    'db-migrate': 'bun wb prisma migrate --check-idempotency',
    'db-view': 'bun wb prisma studio',
  });
});

test('uses bun runner for generated Python scripts in bun projects', async () => {
  const packageJson = await generatePackageJsonFrom(
    { scripts: {} },
    { doesContainUvLock: true },
    { files: { 'src/example.py': '', 'test/unit/test_example.py': '' } }
  );

  expect(packageJson.scripts).toMatchObject({
    'common/ci-setup': 'bun run setup-uv',
    'lint-fix': 'bun wb lint --fix',
    'setup-uv': 'uv sync --frozen',
  });
  expect(packageJson.scripts?.['common/ci-setup']).not.toContain('yarn');
  expect(packageJson.scripts?.['lint-fix']).not.toContain('yarn');
});

test('preserves an already-pinned git commit of a private package instead of bumping it', async () => {
  const pinnedSpecifier = 'git@github.com:WillBoosterLab/llm-proxy.git#4ef9b35e2d1d94adba17e167b7ae18a2e299f7f6';
  const packageJson = await generatePackageJsonFrom({
    devDependencies: { '@willbooster/llm-proxy': pinnedSpecifier },
    scripts: {},
  });

  // The pinned ref survives; only the dependency section is normalized.
  expect(packageJson.dependencies?.['@willbooster/llm-proxy']).toBe(pinnedSpecifier);
  expect(packageJson.devDependencies?.['@willbooster/llm-proxy']).toBeUndefined();
});

test('preserves a leading MISE_ENV prefix on a mise bridge script', async () => {
  const packageJson = await generatePackageJsonFrom(
    {
      scripts: {
        test: 'MISE_ENV=test mise run test',
      },
    },
    { miseTasks: { test: 'bun run playwright test' } }
  );

  expect(packageJson.scripts?.test).toBe('MISE_ENV=test mise run test');
});

test('preserves a quoted MISE_ENV value containing spaces on a mise bridge script', async () => {
  const packageJson = await generatePackageJsonFrom(
    {
      scripts: {
        test: 'MISE_ENV="test development" mise run test',
      },
    },
    { miseTasks: { test: 'bun run playwright test' } }
  );

  expect(packageJson.scripts?.test).toBe('MISE_ENV="test development" mise run test');
});

test('regenerates a plain mise bridge script without inventing an env prefix', async () => {
  const packageJson = await generatePackageJsonFrom(
    {
      scripts: {
        test: 'mise run test',
      },
    },
    { miseTasks: { test: 'bun run playwright test' } }
  );

  expect(packageJson.scripts?.test).toBe('mise run test');
});

test('never generates --bun scripts', async () => {
  const withPlaywright = await generatePackageJsonFrom(
    { scripts: {} },
    { depending: { ...createConfig().depending, playwrightTest: true } }
  );
  const withoutPlaywright = await generatePackageJsonFrom({ scripts: {} }, {});

  expect(withPlaywright.scripts?.['verify-full']).toBe('bun wb verify --full');
  expect(withoutPlaywright.scripts?.['verify-full']).toBe('bun wb verify --full');
  for (const scripts of [withPlaywright.scripts, withoutPlaywright.scripts]) {
    for (const command of Object.values(scripts ?? {})) {
      expect(command).not.toContain('--bun');
    }
  }
});

test('manages trustedDependencies correctly when store-incompatible packages are present', async () => {
  const packageJson = await generatePackageJsonFrom(
    {
      dependencies: {
        'drizzle-kit': '1.0.0',
      },
    },
    { isRoot: true }
  );

  expect(packageJson.trustedDependencies).toEqual(expect.arrayContaining(['drizzle-kit', 'lefthook']));
  expect(packageJson.trustedDependencies).toEqual([...(packageJson.trustedDependencies ?? [])].toSorted());
});

test('trusts @zoom/rtms so Bun installs its native binding', async () => {
  const packageJson = await generatePackageJsonFrom(
    {
      workspaces: ['packages/*'],
    },
    {
      isRoot: true,
      doesContainSubPackageJsons: true,
    },
    {
      files: {
        'packages/server/package.json': JSON.stringify({
          name: 'zoom-bot',
          dependencies: {
            '@zoom/rtms': '1.1.0',
          },
        }),
      },
    }
  );

  expect(packageJson.trustedDependencies).toContain('@zoom/rtms');
});

// wbfy fully owns trustedDependencies: packages whose lifecycle scripts must run get added to
// wbfy itself, so unmanaged entries are removed and the field is deleted when wbfy needs nothing.
test('removes custom trustedDependencies and deletes the field when wbfy needs no entries', async () => {
  const packageJson = await generatePackageJsonFrom(
    {
      dependencies: {},
      trustedDependencies: ['some-custom-dependency'],
    },
    { isRoot: true }
  );

  expect(packageJson.trustedDependencies).toBeUndefined();
});

// An explicit trustedDependencies list replaces Bun's default allow-list, so wbfy writes the
// ENTIRE default list alongside its own entries: uninstalled entries are inert, and no
// intersection with a (possibly missing or stale) lockfile can cover the transitive dependencies
// the final `bun install` resolves only after generation.
test('writes the entire default allow-list alongside wbfy-managed packages', async () => {
  const packageJson = await generatePackageJsonFrom(
    {
      dependencies: {
        'drizzle-kit': '1.0.0',
      },
      trustedDependencies: ['some-custom-dependency'],
    },
    { isRoot: true }
  );

  // Default-trusted packages must be present even though nothing is installed here.
  expect(packageJson.trustedDependencies).toEqual(
    expect.arrayContaining(['@railway/cli', 'drizzle-kit', 'esbuild', 'lefthook', 'node-pty'])
  );
  expect(packageJson.trustedDependencies?.length).toBeGreaterThan(300);
  expect(packageJson.trustedDependencies).not.toContain('some-custom-dependency');
});

test('cleans up wbfy-managed trustedDependencies when they are no longer declared', async () => {
  const packageJson = await generatePackageJsonFrom(
    {
      dependencies: {},
      trustedDependencies: ['@chakra-ui/react', 'drizzle-kit', 'lefthook'],
    },
    { isRoot: true }
  );

  expect(packageJson.trustedDependencies).toBeUndefined();
});

test('removes custom trustedDependencies while cleaning up wbfy-managed ones', async () => {
  const packageJson = await generatePackageJsonFrom(
    {
      dependencies: {},
      trustedDependencies: ['@chakra-ui/react', 'custom-pkg', 'drizzle-kit'],
    },
    { isRoot: true }
  );

  expect(packageJson.trustedDependencies).toBeUndefined();
});

// Even an explicitly empty (block-everything) list is user policy wbfy overrides: the field is
// wbfy-owned, and deleting it restores Bun's default allow-list.
test('deletes an explicitly empty trustedDependencies list', async () => {
  const packageJson = await generatePackageJsonFrom(
    {
      dependencies: {},
      trustedDependencies: [],
    },
    { isRoot: true }
  );

  expect(packageJson.trustedDependencies).toBeUndefined();
});

// @chakra-ui/cli v2's `chakra-cli tokens` writes into @chakra-ui/styled-system, not
// @chakra-ui/react, so trusting @chakra-ui/react there would be inert.
test('does not trust @chakra-ui/react for @chakra-ui/cli v2', async () => {
  const packageJson = await generatePackageJsonFrom(
    {
      dependencies: { '@chakra-ui/react': '^2.10.9' },
      devDependencies: { '@chakra-ui/cli': '^2.5.8' },
    },
    { isRoot: true }
  );

  expect(packageJson.trustedDependencies).toBeUndefined();
});

test('keeps a plain monorepo root private', async () => {
  const packageJson = await generatePackageJsonFrom(
    { name: 'monorepo', workspaces: ['packages/*'] },
    { isRoot: true, doesContainSubPackageJsons: true }
  );

  expect(packageJson.private).toBe(true);
});

test('creates the managed manifest for a repository without package.json', async () => {
  const packageJson = await generatePackageJsonFrom({}, { isRoot: true }, { omitInitialPackageJson: true });

  expect(packageJson.name).toBeDefined();
  expect(packageJson.license).toBe('UNLICENSED');
  expect(packageJson.scripts?.cleanup).toBe('bun wb lint --fix --format');
});

// @semantic-release/npm silently skips private packages, so forcing `private: true` on a
// publishing monorepo root (e.g. WillBoosterLab/llm-proxy) would stop releases without any error.
test('does not force private on a monorepo root released via @semantic-release/npm', async () => {
  const packageJson = await generatePackageJsonFrom(
    { name: '@willbooster-private/llm-proxy', private: false, workspaces: ['packages/*'] },
    {
      isRoot: true,
      doesContainSubPackageJsons: true,
      release: { branches: ['main'], github: true, npm: true, npmPublishesRoot: false },
    }
  );

  expect(packageJson.private).toBe(false);
});

// Older wbfy forced `private: true` on every monorepo root; when the user explicitly configured
// `@semantic-release/npm` to publish the root itself, the stale flag silently suppresses
// publishing, so the generator must migrate it away on upgrade.
test('removes stale private from a monorepo root explicitly publishing itself via @semantic-release/npm', async () => {
  const packageJson = await generatePackageJsonFrom(
    { name: '@willbooster-private/llm-proxy', private: true, workspaces: ['packages/*'] },
    {
      isRoot: true,
      doesContainSubPackageJsons: true,
      release: { branches: ['main'], github: true, npm: true, npmPublishesRoot: true },
    }
  );

  expect(packageJson.private).toBeUndefined();
});

test('does not force private on a monorepo root with a publishConfig', async () => {
  const packageJson = await generatePackageJsonFrom(
    { name: 'published-monorepo', workspaces: ['packages/*'], publishConfig: { registry: 'https://npm.example.com' } },
    { isRoot: true, doesContainSubPackageJsons: true }
  );

  expect(packageJson.private).toBeUndefined();
});

test('removes stale private from a monorepo root with a publishConfig', async () => {
  const packageJson = await generatePackageJsonFrom(
    {
      name: 'published-monorepo',
      private: true,
      workspaces: ['packages/*'],
      publishConfig: { registry: 'https://npm.example.com' },
    },
    { isRoot: true, doesContainSubPackageJsons: true }
  );

  expect(packageJson.private).toBeUndefined();
});

test('pins the publish registry of a public-repo package to npmjs', async () => {
  const packageJson = await generatePackageJsonFrom({ name: 'public-lib', license: 'Apache-2.0' });

  expect(packageJson.publishConfig).toEqual({ access: 'public', registry: 'https://registry.npmjs.org/' });
});

test('keeps a deliberately different publish registry', async () => {
  const packageJson = await generatePackageJsonFrom({
    name: 'public-lib',
    license: 'Apache-2.0',
    publishConfig: { registry: 'https://npm.example.com/' },
  });

  expect(packageJson.publishConfig?.registry).toBe('https://npm.example.com/');
});

test('adds no publishConfig in a private repository', async () => {
  const packageJson = await generatePackageJsonFrom(
    { name: 'private-repo-lib', license: 'Apache-2.0' },
    { isPublicRepo: false }
  );

  expect(packageJson.publishConfig).toBeUndefined();
});

test('strips `bun --bun` only from command-position invocations of Node-based tools', async () => {
  const packageJson = await generatePackageJsonFrom(
    {
      scripts: {
        // Node-based tool invocations lose `--bun`.
        build: 'bun --bun next build',
        dev: 'bun --bun next dev',
        start: 'bun --bun next start && bun --bun wrangler tail',
        'run-alias': 'bun --bun run build',
        'run-tool': 'bun --bun run next start',
        'quoted-executable': '"bun" --bun next build',
        multiline: 'bun --bun next build\nbun --bun wrangler tail',
        'env-prefix': 'NODE_ENV=production bun --bun next build',
        // Direct script-file executions keep `--bun`.
        'file-exec': 'exec bun --bun src/index.ts',
        'file-chained': 'bun --bun src/index.ts;echo done',
        'file-quoted': 'bun --bun "src/index.ts"',
        'file-spaced-path': 'bun --bun "src/my script.ts"',
        'file-runtime-flags': 'bun --bun --smol src/index.ts',
        'file-variable': 'bun --bun "$ENTRYPOINT"',
        'file-run-file': 'bun --bun run ./src/index.ts',
        'file-extensionless': 'bun --bun ./scripts/server',
        'file-bare-file': 'bun --bun server',
        'file-run-missing': 'bun --bun run server',
        'file-quoted-flag': 'bun --bun run "--preload" ./setup.ts',
        'file-flag-value': 'bun --bun --cwd packages/app src/index.ts',
        // `bun --bun` outside a command position is data, not a command.
        'echo-literal': 'echo "bun --bun next build"',
        'nested-literal': `node -e 'console.log("use bun --bun next")'`,
        'other-tool': 'my-bun --bun next build',
      },
    },
    {}
  );

  expect(packageJson.scripts).toMatchObject({
    build: 'bun next build',
    dev: 'bun next dev',
    start: 'bun next start && bun wrangler tail',
    'run-alias': 'bun run build',
    'run-tool': 'bun run next start',
    'quoted-executable': '"bun" next build',
    multiline: 'bun next build\nbun wrangler tail',
    'env-prefix': 'NODE_ENV=production bun next build',
    'file-exec': 'exec bun --bun src/index.ts',
    'file-chained': 'bun --bun src/index.ts;echo done',
    'file-quoted': 'bun --bun "src/index.ts"',
    'file-spaced-path': 'bun --bun "src/my script.ts"',
    'file-runtime-flags': 'bun --bun --smol src/index.ts',
    'file-variable': 'bun --bun "$ENTRYPOINT"',
    'file-run-file': 'bun --bun run ./src/index.ts',
    'file-extensionless': 'bun --bun ./scripts/server',
    'file-bare-file': 'bun --bun server',
    'file-run-missing': 'bun --bun run server',
    'file-quoted-flag': 'bun --bun run "--preload" ./setup.ts',
    'file-flag-value': 'bun --bun --cwd packages/app src/index.ts',
    'echo-literal': 'echo "bun --bun next build"',
    'nested-literal': `node -e 'console.log("use bun --bun next")'`,
    'other-tool': 'my-bun --bun next build',
  });
});

test('generates test/ci script running wb test-on-ci at the root', async () => {
  const packageJson = await generatePackageJsonFrom({ scripts: {} }, { isRoot: true });
  expect(packageJson.scripts?.['test/ci']).toBe('bun wb test-on-ci');
});

test('replaces the previous Bun-generated test/ci variant with the current one', async () => {
  const packageJson = await generatePackageJsonFrom(
    { scripts: { 'test/ci': 'bun --bun wb test-on-ci' } },
    { isRoot: true }
  );
  expect(packageJson.scripts?.['test/ci']).toBe('bun wb test-on-ci');
});

test('preserves a custom test/ci wrapper', async () => {
  const customScript = 'wb test test/unit && playwright test';
  const packageJson = await generatePackageJsonFrom({ scripts: { 'test/ci': customScript } }, { isRoot: true });
  expect(packageJson.scripts?.['test/ci']).toBe(customScript);
});

test('does not generate test/ci in a workspace package', async () => {
  const packageJson = await generatePackageJsonFrom({ scripts: {} }, { isRoot: false });
  expect(packageJson.scripts?.['test/ci']).toBeUndefined();
});

const jsRootConfig = { doesContainTypeScript: true, isRoot: true } as const;

test('downgrades a managed tool pin that the generated release-age gate rejects', async () => {
  const packageJson = await generatePackageJsonFrom(
    {
      devDependencies: { oxfmt: '999.0.0' },
    },
    jsRootConfig,
    { skipAddingDeps: false }
  );

  expect(packageJson.devDependencies?.oxfmt).toMatch(/^\d+\.\d+\.\d+/u);
  expect(packageJson.devDependencies?.oxfmt).not.toBe('999.0.0');
}, 30_000);

test('removes TypeScript compilers from a repository without TypeScript', async () => {
  const withoutTypeScript = await generatePackageJsonFrom({
    devDependencies: {
      '@typescript/native-preview': '7.0.0-dev.20260707.2',
      typescript: '7.0.2',
    },
  });
  expect(withoutTypeScript.devDependencies?.['@typescript/native-preview']).toBeUndefined();
  expect(withoutTypeScript.devDependencies?.typescript).toBeUndefined();
});

test('removes a package self-dependency from every dependency section', async () => {
  const packageJson = await generatePackageJsonFrom({
    name: '@example/self-referencing',
    dependencies: { '@example/self-referencing': '1.0.0' },
    devDependencies: { '@example/self-referencing': '1.0.0' },
    peerDependencies: { '@example/self-referencing': '1.0.0' },
  });
  expect(packageJson.dependencies?.['@example/self-referencing']).toBeUndefined();
  expect(packageJson.devDependencies?.['@example/self-referencing']).toBeUndefined();
  expect(packageJson.peerDependencies?.['@example/self-referencing']).toBeUndefined();
});

test('removes standalone CLI dependencies when scripts use the wb replacements', async () => {
  const packageJson = await generatePackageJsonFrom({
    scripts: { preview: 'bun wb wait-on tcp:3000 && bun wb open-cli http://localhost:3000' },
    devDependencies: { 'open-cli': '8.0.0', 'wait-on': '9.0.1' },
  });

  expect(packageJson.devDependencies?.['open-cli']).toBeUndefined();
  expect(packageJson.devDependencies?.['wait-on']).toBeUndefined();
});

test('preserves standalone CLI dependencies when scripts execute their bins', async () => {
  const packageJson = await generatePackageJsonFrom({
    scripts: { preview: 'bun wait-on tcp:3000 && bun run open-cli http://localhost:3000' },
    devDependencies: { 'open-cli': '8.0.0', 'wait-on': '9.0.1' },
  });

  expect(packageJson.devDependencies?.['open-cli']).toBe('8.0.0');
  expect(packageJson.devDependencies?.['wait-on']).toBe('9.0.1');
});

test.each([
  'concurrently',
  'wb concurrently',
  'bun concurrently',
  'bun wb concurrently',
  'bun run concurrently',
  'bun run wb concurrently',
])('preserves standalone CLI dependencies in %s child commands', async (runner) => {
  const packageJson = await generatePackageJsonFrom({
    scripts: { preview: `${runner} "bun run start" "wait-on tcp:3000 && open-cli http://localhost:3000"` },
    devDependencies: { 'open-cli': '8.0.0', 'wait-on': '9.0.1' },
  });

  expect(packageJson.devDependencies?.['open-cli']).toBe('8.0.0');
  expect(packageJson.devDependencies?.['wait-on']).toBe('9.0.1');
});

test('keeps commands chained onto the generated test and verify-full scripts', async () => {
  const packageJson = await generatePackageJsonFrom(
    {
      scripts: {
        test: 'bun wb test && bun run test/analyzers',
        'verify-full': 'bun wb verify --full && bun run test/analyzers',
      },
    },
    jsRootConfig
  );

  expect(packageJson.scripts).toMatchObject({
    test: 'bun wb test && bun run test/analyzers',
    'verify-full': 'bun wb verify --full && bun run test/analyzers',
  });
});

test('normalizes the runner prefix of a chained test script instead of freezing it', async () => {
  // Existing manifests may spell the wrapper as `bun run wb test`, and `--bun` breaks Node-based
  // tools; both must converge on the generated command so the next run still recognizes the body.
  const packageJson = await generatePackageJsonFrom(
    { scripts: { test: 'bun run wb test && mvn test', 'verify-full': 'bun --bun wb verify --full; mvn test' } },
    jsRootConfig
  );

  expect(packageJson.scripts).toMatchObject({
    test: 'bun wb test && mvn test',
    'verify-full': 'bun wb verify --full; mvn test',
  });
});

test('keeps a command chained onto the generated test script with a newline', async () => {
  const packageJson = await generatePackageJsonFrom({ scripts: { test: 'bun wb test\nmvn test' } }, jsRootConfig);
  expect(packageJson.scripts?.test).toBe('bun wb test\nmvn test');
});

test('replaces a plain generated test script body', async () => {
  const packageJson = await generatePackageJsonFrom({ scripts: { test: 'bun --bun wb test' } }, jsRootConfig);
  expect(packageJson.scripts?.test).toBe('bun wb test');
});

async function generatePackageJsonFrom(
  initialPackageJson: Record<string, unknown>,
  configOverrides: Parameters<typeof createConfig>[0] = {},
  options: {
    createI18nDir?: boolean;
    files?: Record<string, string>;
    omitInitialPackageJson?: boolean;
    skipAddingDeps?: boolean;
  } = {}
): Promise<GeneratedPackageJson> {
  const dirPath = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'wbfy-package-json-')));
  const packageJsonPath = path.join(dirPath, 'package.json');

  try {
    if (options.createI18nDir) {
      await fs.mkdir(path.join(dirPath, 'i18n'));
    }
    for (const [relativePath, content] of Object.entries(options.files ?? {})) {
      const filePath = path.join(dirPath, relativePath);
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, content);
    }
    if (!options.omitInitialPackageJson) {
      await fs.writeFile(packageJsonPath, JSON.stringify(initialPackageJson));
    }

    const config = createConfig({
      packageJson: initialPackageJson as PackageJson,
      ...configOverrides,
      dirPath,
    });
    await generatePackageJson(config, config, options.skipAddingDeps ?? true);

    return JSON.parse(await fs.readFile(packageJsonPath, 'utf8')) as GeneratedPackageJson;
  } finally {
    await fs.rm(dirPath, { force: true, recursive: true });
  }
}
