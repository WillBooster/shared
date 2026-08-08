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

test('replaces default gen-i18n-ts postinstall with managed wb gen-code scripts', async () => {
  const packageJson = await generatePackageJsonFrom(
    {
      scripts: {
        'gen-i18n-ts': 'gen-i18n-ts -i i18n -o src/__generated__/i18n.ts -d ja-JP',
        postinstall: 'yarn run gen-i18n-ts > /dev/null',
      },
      dependencies: {
        'gen-i18n-ts': '4.0.6',
      },
    },
    { depending: genI18nTsDepending, isRoot: true },
    { createI18nDir: true }
  );

  expect(packageJson.scripts).toMatchObject({
    cleanup: 'bun wb lint --fix --format',
    'gen-code': 'bun wb gen-code',
    postinstall: 'wb gen-code',
  });
  expect(packageJson.scripts?.['gen-i18n-ts']).toBeUndefined();
});

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
    postinstall: 'wb gen-code',
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

// Unparseable legacy shapes (redirections, empty segments) whose every command `wb gen-code` already runs.
test.each([
  ['redirections around gen-i18n-ts', 'yarn run gen-i18n-ts > /dev/null'],
  ['empty command segments around gen-i18n-ts', ' && yarn gen-i18n-ts && bun   run   gen-i18n-ts>/dev/null && '],
])('replaces %s with managed wb gen-code postinstall', async (_description, postinstall) => {
  const packageJson = await generatePackageJsonFrom(
    {
      scripts: {
        postinstall,
      },
      dependencies: {
        'gen-i18n-ts': '4.0.6',
      },
    },
    { depending: genI18nTsDepending },
    { createI18nDir: true }
  );

  expect(packageJson.scripts?.postinstall).toBe('wb gen-code');
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

// `wb gen-code` generates worker-configuration.d.ts itself, so wbfy no longer weaves `wrangler types` into the
// managed scripts: a Cloudflare package normalizes to the same `bun wb gen-code` / `wb gen-code` pair as any other.
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
    postinstall: 'wb gen-code',
  });
});

// The shapes the repositories actually carried before `wb gen-code` learned to run `wrangler types`. Only the
// invocations equivalent to the bare one go: `--env-file` names a file fnox repositories no longer have, and it
// does not change what is generated. Flags that DO change the output are covered by the next test.
test.each([
  ['a generator appended to gen-code', { 'gen-code': 'wb gen-code && wrangler types' }],
  ['a bare generator in postinstall', { postinstall: 'wrangler types' }],
  ['an env-file generator', { postinstall: 'wrangler types --env-file custom.env' }],
  ['a bunx generator', { postinstall: 'wb gen-code && bunx wrangler types' }],
  ['a gen-types script', { 'gen-types': 'wrangler types' }],
  [
    'a gen-types wrapper',
    { 'gen-types': 'wrangler types --env-file .env', postinstall: 'bun run gen-types && wb gen-code' },
  ],
])('drops %s from the managed scripts', async (_description, scripts) => {
  const wranglerPackageJson = { devDependencies: { wrangler: '4.69.0' }, scripts };
  const packageJson = await generatePackageJsonFrom(
    { ...wranglerPackageJson },
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
    postinstall: 'wb gen-code',
  });
  expect(packageJson.scripts?.['gen-types']).toBeUndefined();
});

// `wb gen-code` is the sole supported worker-types generator, so output-changing project invocations are replaced
// instead of leaving the generated file tracked or producing a repository-specific shape.
test('normalizes a package carrying output-changing worker-types flags', async () => {
  const scripts = { 'gen-types': 'wrangler types --strict-vars=false' };
  const wranglerPackageJson = { devDependencies: { wrangler: '4.69.0' }, scripts };
  const packageJson = await generatePackageJsonFrom(
    { ...wranglerPackageJson },
    {
      depending: genI18nTsDepending,
      isCloudflare: true,
      doesContainWranglerConfig: true,
      packageJson: wranglerPackageJson,
    },
    { createI18nDir: true }
  );

  expect(packageJson.scripts?.postinstall).toBe('wb gen-code');
  expect(packageJson.scripts?.['gen-types']).toBeUndefined();
});

test.each([
  ['a referenced alias', { 'gen-types': 'wrangler types', build: 'bun run gen-types && vite build' }],
  ['a compound alias', { 'gen-types': 'wrangler types && echo custom', postinstall: 'bun run gen-types' }],
  ['an arbitrary generator name', { 'types:worker': 'wrangler types --strict-vars=false' }],
  ['an output path', { postinstall: 'wrangler types --path src/env.d.ts' }],
  ['unsupported shell syntax', { postinstall: 'cd sub && wrangler types' }],
])('rejects %s instead of partially normalizing it', async (_description, scripts) => {
  const wranglerPackageJson = { devDependencies: { wrangler: '4.69.0' }, scripts };
  const packageJson = await generatePackageJsonFrom(
    { ...wranglerPackageJson },
    {
      isCloudflare: true,
      doesContainWranglerConfig: true,
      packageJson: wranglerPackageJson,
    }
  );

  expect(packageJson.scripts).toEqual(scripts);
});

// `--check` validates freshness and writes nothing, so it cannot conflict with the managed generator and must
// not strip the managed setup from the package.
test('keeps managing a package whose extra script only checks the types', async () => {
  const scripts = { 'check-types': 'wrangler types --check' };
  const wranglerPackageJson = { devDependencies: { wrangler: '4.69.0' }, scripts };
  const packageJson = await generatePackageJsonFrom(
    { ...wranglerPackageJson },
    {
      depending: genI18nTsDepending,
      isCloudflare: true,
      doesContainWranglerConfig: true,
      packageJson: wranglerPackageJson,
    },
    { createI18nDir: true }
  );

  expect(packageJson.scripts?.postinstall).toBe('wb gen-code');
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

  expect(packageJson.scripts?.postinstall).toBe('wb gen-code && bun run build-assets');
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

  expect(packageJson.scripts?.postinstall).toBe('wb gen-code');
});

// A hand-written gen-code script wbfy would not generate itself still has to lose what `wb gen-code` subsumes,
// or the redundant invocation survives every future run.
test('strips a subsumed wrangler types from a gen-code script wbfy does not generate', async () => {
  const wranglerPackageJson = {
    devDependencies: { wrangler: '4.69.0' },
    scripts: { 'gen-code': 'wb gen-code && bunx wrangler types' },
  };
  const packageJson = await generatePackageJsonFrom(
    { ...wranglerPackageJson },
    { isCloudflare: true, doesContainWranglerConfig: true, packageJson: wranglerPackageJson }
  );

  expect(packageJson.scripts?.['gen-code']).toBe('bun wb gen-code');
});

// Its custom steps must keep running, and keep their position relative to the generation.
test('keeps custom steps when stripping an unmanaged gen-code script', async () => {
  const wranglerPackageJson = {
    devDependencies: { wrangler: '4.69.0' },
    scripts: { 'gen-code': 'wb gen-code && bunx wrangler types && bun run build-assets' },
  };
  const packageJson = await generatePackageJsonFrom(
    { ...wranglerPackageJson },
    { isCloudflare: true, doesContainWranglerConfig: true, packageJson: wranglerPackageJson }
  );

  expect(packageJson.scripts?.['gen-code']).toBe('bun wb gen-code && bun run build-assets');
});

// Silently dropping a project's own install step (e.g. applying patches) would break its install.
test('preserves custom postinstall segments', async () => {
  const packageJson = await generatePackageJsonFrom(
    { scripts: { 'gen-code': 'bun wb gen-code', postinstall: 'patch-package && bun run gen-code' } },
    { depending: genI18nTsDepending },
    { createI18nDir: true }
  );

  expect(packageJson.scripts?.postinstall).toBe('patch-package && wb gen-code');
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

  expect(packageJson.scripts?.postinstall).toBe('node scripts/writeDevVars.js && wb gen-code');
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

  expect(packageJson.scripts?.postinstall).toBe('wb gen-code');
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
});

test('replaces plain generated db script bodies (with or without runner prefixes)', async () => {
  const packageJson = await generatePackageJsonFrom(
    {
      scripts: {
        'db-create-migration': 'yarn wb prisma migrate-dev',
        'db-migrate': 'bun wb prisma migrate',
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

// `wb gen-code` supplies its own `--env-file` stub from the committed fnox.toml, so an env-file-only invocation
// is equivalent to the managed generation even when the named file exists on this machine. Classifying it by
// local file existence would flip the worker-types management decision between dev machines (where `wb deploy`
// creates `.env.cloudflare`) and clean checkouts — the tracked/untracked oscillation this predicate must avoid.
test('normalizes an env-file wrangler types script even when the named file exists locally', async () => {
  const wranglerPackageJson = { devDependencies: { wrangler: '4.107.0' } };
  const packageJson = await generatePackageJsonFrom(
    {
      scripts: {
        'gen-types': 'wrangler types --env-file .env.cloudflare',
      },
      ...wranglerPackageJson,
    },
    // No packageJson override: config.packageJson stays the on-disk package.json, including its legacy script.
    { isCloudflare: true, doesContainWranglerConfig: true },
    { files: { 'wrangler.jsonc': '{}', '.env.cloudflare': 'CLOUDFLARE_API_TOKEN=dummy\n' } }
  );

  expect(packageJson.scripts?.postinstall).toBe('wb gen-code');
  expect(packageJson.scripts?.['gen-types']).toBeUndefined();
});

test('generates test/ci script running wb test-on-ci at the root', async () => {
  const packageJson = await generatePackageJsonFrom({ scripts: {} }, { isRoot: true });
  expect(packageJson.scripts?.['test/ci']).toBe('bun wb test-on-ci');
});

test('replaces a legacy generated test/ci variant with the current one', async () => {
  const packageJson = await generatePackageJsonFrom({ scripts: { 'test/ci': 'yarn wb test-on-ci' } }, { isRoot: true });
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
  const packageJson = await generatePackageJsonFrom({ scripts: { test: 'yarn wb test' } }, jsRootConfig);
  expect(packageJson.scripts?.test).toBe('bun wb test');
});

async function generatePackageJsonFrom(
  initialPackageJson: Record<string, unknown>,
  configOverrides: Parameters<typeof createConfig>[0] = {},
  options: { createI18nDir?: boolean; files?: Record<string, string>; skipAddingDeps?: boolean } = {}
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
    await fs.writeFile(packageJsonPath, JSON.stringify(initialPackageJson));

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
