import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { expect, test } from 'vitest';

import { generatePackageJson } from '../src/generators/packageJson.js';
import { createConfig } from './testConfig.js';

interface GeneratedPackageJson {
  dependencies?: Record<string, string | undefined>;
  devDependencies?: Record<string, string | undefined>;
  scripts?: Record<string, string | undefined>;
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
    cleanup: 'yarn format',
    'gen-code': 'wb gen-code',
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
    cleanup: 'yarn format',
    'gen-code': 'wb gen-code',
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
    'gen-code': 'wb gen-code',
    'gen-i18n-ts': 'gen-i18n-ts -i locales -o src/i18n.ts -d en-US',
  });
});

test.each([
  ['mixed commands around gen-i18n-ts', 'echo before && yarn run gen-i18n-ts > /dev/null && echo after'],
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
  expect(packageJson.devDependencies?.['@willbooster/wb']).toBeUndefined();
});

test('uses stable age-gated versions for generated dependencies when skipping installs', async () => {
  const packageJson = await generatePackageJsonFrom({}, { doesContainJava: true });

  expect(packageJson.devDependencies?.prettier).toMatch(/^\d+\.\d+\.\d+$/u);
});

test('appends wrangler types to gen-code and postinstall for Cloudflare projects', async () => {
  const wranglerPackageJson = { devDependencies: { wrangler: '4.42.0' } };
  const packageJson = await generatePackageJsonFrom(
    { scripts: {}, ...wranglerPackageJson },
    {
      depending: genI18nTsDepending,
      isBun: true,
      isCloudflare: true,
      doesContainWranglerConfig: true,
      packageJson: wranglerPackageJson,
    },
    { createI18nDir: true }
  );

  expect(packageJson.scripts).toMatchObject({
    'gen-code': 'bun wb gen-code && bunx wrangler types',
    postinstall: 'wb gen-code && bunx wrangler types',
  });
});

// --strict-vars=false widens `vars` to string, while the default emits literal union types, so resetting a project's
// flags would silently change the generated declarations. Both managed scripts must run the very same command, or the
// file would depend on whether install or `run gen-code` happened to run last.
test.each([
  ['postinstall', { postinstall: 'wb gen-code && wrangler types --strict-vars=false' }],
  ['a script of its own', { 'gen-types': 'wrangler types --strict-vars=false' }],
])('preserves a project-specific wrangler types invocation kept in %s', async (_description, scripts) => {
  const wranglerPackageJson = { devDependencies: { wrangler: '4.42.0' } };
  const packageJson = await generatePackageJsonFrom(
    { scripts, ...wranglerPackageJson },
    {
      depending: genI18nTsDepending,
      isBun: true,
      isCloudflare: true,
      doesContainWranglerConfig: true,
      packageJson: wranglerPackageJson,
    },
    { createI18nDir: true }
  );

  expect(packageJson.scripts).toMatchObject({
    'gen-code': 'bun wb gen-code && wrangler types --strict-vars=false',
    postinstall: 'wb gen-code && wrangler types --strict-vars=false',
  });
});

// wbfy gitignores and untracks worker-configuration.d.ts only where postinstall regenerates it, so a package that
// cannot run wrangler must not gain the command either.
test('omits wrangler types when the package does not depend on wrangler', async () => {
  const packageJson = await generatePackageJsonFrom(
    { scripts: {} },
    { depending: genI18nTsDepending, isBun: true, isCloudflare: true, doesContainWranglerConfig: true },
    { createI18nDir: true }
  );

  expect(packageJson.scripts?.postinstall).toBe('wb gen-code');
});

// `wrangler types` exits non-zero without a wrangler config, which would break `install` for the whole repository.
test('omits wrangler types when the package owns no wrangler config', async () => {
  const packageJson = await generatePackageJsonFrom(
    // A monorepo root merely referring to the Worker of a sub-package makes isCloudflare true.
    { scripts: { 'db-reset': 'rm -rf packages/web/.wrangler/state' } },
    { depending: genI18nTsDepending, isBun: true, isCloudflare: true, doesContainWranglerConfig: false },
    { createI18nDir: true }
  );

  expect(packageJson.scripts?.['gen-code']).toBe('bun wb gen-code');
  expect(packageJson.scripts?.postinstall).toBe('wb gen-code');
});

// `wrangler types --check` validates freshness and generates nothing, and a positional output path generates a
// different file than the worker-configuration.d.ts wbfy manages, so neither can serve as the shared generator.
test('ignores non-generating and custom-output wrangler types invocations when resolving the command', async () => {
  const wranglerPackageJson = { devDependencies: { wrangler: '4.42.0' } };
  const packageJson = await generatePackageJsonFrom(
    {
      scripts: {
        'check-types': 'wrangler types --check',
        'gen-bindings': 'wrangler types src/bindings.d.ts --strict-vars=false',
      },
      ...wranglerPackageJson,
    },
    {
      depending: genI18nTsDepending,
      isBun: true,
      isCloudflare: true,
      doesContainWranglerConfig: true,
      packageJson: wranglerPackageJson,
    },
    { createI18nDir: true }
  );

  expect(packageJson.scripts).toMatchObject({
    'gen-code': 'bun wb gen-code && bunx wrangler types',
    postinstall: 'wb gen-code && bunx wrangler types',
  });
});

// Appending the resolved command to a postinstall that already generates through a wrapper script would generate
// the ~15k-line file twice per install.
test('does not append wrangler types to a postinstall that generates through a wrapper script', async () => {
  const wranglerPackageJson = { devDependencies: { wrangler: '4.42.0' } };
  const packageJson = await generatePackageJsonFrom(
    {
      scripts: {
        'gen:types': 'wrangler types --strict-vars=false',
        postinstall: 'yarn gen:types',
      },
      ...wranglerPackageJson,
    },
    { isBun: true, isCloudflare: true, doesContainWranglerConfig: true, packageJson: wranglerPackageJson }
  );

  expect(packageJson.scripts?.postinstall).toBe('yarn gen:types');
});

// detectWranglerConfig does not see a custom --config path, so wbfy does not manage the file — but overwriting the
// project's own postinstall invocation would leave fresh checkouts without worker types.
test('preserves a wrangler types invocation with a custom config path when overwriting postinstall', async () => {
  const wranglerPackageJson = { devDependencies: { wrangler: '4.42.0' } };
  const packageJson = await generatePackageJsonFrom(
    {
      scripts: { postinstall: 'wb gen-code && wrangler types --config config/worker.jsonc' },
      ...wranglerPackageJson,
    },
    {
      depending: genI18nTsDepending,
      isBun: true,
      isCloudflare: true,
      doesContainWranglerConfig: false,
      packageJson: wranglerPackageJson,
    },
    { createI18nDir: true }
  );

  expect(packageJson.scripts?.postinstall).toBe('wb gen-code && wrangler types --config config/worker.jsonc');
});

// The generated file is a pure function of committed inputs only when the `Env` inference source (.dev.vars,
// falling back to .env) is committed, absent, or overridden by a top-level `secrets.required` declaration; wbfy
// must not manage (generate, ignore, untrack) a file CI would regenerate differently.
test('omits wrangler types when an uncommitted .dev.vars drives the Env inference', async () => {
  const wranglerPackageJson = { devDependencies: { wrangler: '4.42.0' } };
  const packageJson = await generatePackageJsonFrom(
    { scripts: {}, ...wranglerPackageJson },
    {
      depending: genI18nTsDepending,
      isBun: true,
      isCloudflare: true,
      doesContainWranglerConfig: true,
      packageJson: wranglerPackageJson,
    },
    // The temp directory is not a git repository, so the file counts as uncommitted.
    { createI18nDir: true, files: { '.dev.vars': 'AUTH_SECRET=local-secret\n', 'wrangler.jsonc': '{}' } }
  );

  expect(packageJson.scripts?.postinstall).toBe('wb gen-code');
});

test('keeps wrangler types when secrets.required makes the Env inference reproducible', async () => {
  // 4.77.0 is the first wrangler that generates types from secrets.required instead of .dev.vars.
  const wranglerPackageJson = { devDependencies: { wrangler: '4.77.0' } };
  const packageJson = await generatePackageJsonFrom(
    { scripts: {}, ...wranglerPackageJson },
    {
      depending: genI18nTsDepending,
      isBun: true,
      isCloudflare: true,
      doesContainWranglerConfig: true,
      packageJson: wranglerPackageJson,
    },
    {
      createI18nDir: true,
      files: {
        '.dev.vars': 'AUTH_SECRET=local-secret\n',
        // JSONC comments and trailing commas must parse.
        'wrangler.jsonc': `{
          // Secrets are declared, so .dev.vars no longer drives the Env inference.
          "secrets": { "required": ["AUTH_SECRET"], },
        }`,
      },
    }
  );

  expect(packageJson.scripts?.postinstall).toBe('wb gen-code && bunx wrangler types');
});

// Wranglers older than 4.77.0 warn about the unexpected top-level `secrets` field and keep inferring from
// .dev.vars, so the declaration must not count as a reproducible inference source for them.
test('ignores secrets.required when the wrangler dependency predates its support', async () => {
  const wranglerPackageJson = { devDependencies: { wrangler: '4.42.0' } };
  const packageJson = await generatePackageJsonFrom(
    { scripts: {}, ...wranglerPackageJson },
    {
      depending: genI18nTsDepending,
      isBun: true,
      isCloudflare: true,
      doesContainWranglerConfig: true,
      packageJson: wranglerPackageJson,
    },
    {
      createI18nDir: true,
      files: {
        '.dev.vars': 'AUTH_SECRET=local-secret\n',
        'wrangler.jsonc': `{ "secrets": { "required": ["AUTH_SECRET"] } }`,
      },
    }
  );

  expect(packageJson.scripts?.postinstall).toBe('wb gen-code');
});

// Running the documented code-generation entry point must produce the same declarations as postinstall,
// even when wbfy would not create the gen-code script from scratch.
test('appends wrangler types to a project-specific gen-code script', async () => {
  const wranglerPackageJson = { devDependencies: { wrangler: '4.42.0' } };
  const packageJson = await generatePackageJsonFrom(
    { scripts: { 'gen-code': 'tsx scripts/genRoutes.ts' }, ...wranglerPackageJson },
    { isBun: true, isCloudflare: true, doesContainWranglerConfig: true, packageJson: wranglerPackageJson }
  );

  expect(packageJson.scripts).toMatchObject({
    'gen-code': 'tsx scripts/genRoutes.ts && bunx wrangler types',
    postinstall: 'wb gen-code && bunx wrangler types',
  });
});

// Only a command-position invocation counts: shell text that merely mentions the words must not be
// selected as the shared generator.
test('does not treat shell text mentioning wrangler types as the generator command', async () => {
  const wranglerPackageJson = { devDependencies: { wrangler: '4.42.0' } };
  const packageJson = await generatePackageJsonFrom(
    { scripts: { help: 'echo wrangler types --strict-vars=false' }, ...wranglerPackageJson },
    {
      depending: genI18nTsDepending,
      isBun: true,
      isCloudflare: true,
      doesContainWranglerConfig: true,
      packageJson: wranglerPackageJson,
    },
    { createI18nDir: true }
  );

  expect(packageJson.scripts?.postinstall).toBe('wb gen-code && bunx wrangler types');
});

// --cwd/--config/--env change the config, output directory, or .dev.vars inference inputs away from the ones the
// management gate validated, and --check=true generates nothing, so none can serve as the shared generator.
test('ignores context-changing wrangler types invocations when resolving the command', async () => {
  const wranglerPackageJson = { devDependencies: { wrangler: '4.42.0' } };
  const packageJson = await generatePackageJsonFrom(
    {
      scripts: {
        'check-types': 'wrangler types --check=true',
        'gen-staging': 'wrangler types --env staging --strict-vars=false',
        'gen-other': 'wrangler types --config config/worker.jsonc --strict-vars=false',
      },
      ...wranglerPackageJson,
    },
    {
      depending: genI18nTsDepending,
      isBun: true,
      isCloudflare: true,
      doesContainWranglerConfig: true,
      packageJson: wranglerPackageJson,
    },
    { createI18nDir: true }
  );

  expect(packageJson.scripts?.postinstall).toBe('wb gen-code && bunx wrangler types');
});

// Wrangler's documented default output path is exactly ./worker-configuration.d.ts, so naming it explicitly
// must not discard the project's flags.
test('reuses a wrangler types invocation that names the default output path explicitly', async () => {
  const wranglerPackageJson = { devDependencies: { wrangler: '4.42.0' } };
  const packageJson = await generatePackageJsonFrom(
    {
      scripts: { 'gen-types': 'wrangler types ./worker-configuration.d.ts --strict-vars=false' },
      ...wranglerPackageJson,
    },
    {
      depending: genI18nTsDepending,
      isBun: true,
      isCloudflare: true,
      doesContainWranglerConfig: true,
      packageJson: wranglerPackageJson,
    },
    { createI18nDir: true }
  );

  expect(packageJson.scripts?.postinstall).toBe(
    'wb gen-code && wrangler types ./worker-configuration.d.ts --strict-vars=false'
  );
});

// --help/--version generate nothing, and --env-file loads inference inputs the reproducibility gate never
// checked, so neither can be selected as the shared generator.
test('ignores help and env-file wrangler types invocations when resolving the command', async () => {
  const wranglerPackageJson = { devDependencies: { wrangler: '4.42.0' } };
  const packageJson = await generatePackageJsonFrom(
    {
      scripts: {
        'types-help': 'wrangler types --help',
        'gen-local': 'wrangler types --env-file local.env --strict-vars=false',
      },
      ...wranglerPackageJson,
    },
    {
      depending: genI18nTsDepending,
      isBun: true,
      isCloudflare: true,
      doesContainWranglerConfig: true,
      packageJson: wranglerPackageJson,
    },
    { createI18nDir: true }
  );

  expect(packageJson.scripts?.postinstall).toBe('wb gen-code && bunx wrangler types');
});

// Boolean options accept a space-separated literal, which must not be misread as a positional output path.
test('reuses a wrangler types invocation with a space-separated boolean option', async () => {
  const wranglerPackageJson = { devDependencies: { wrangler: '4.42.0' } };
  const packageJson = await generatePackageJsonFrom(
    { scripts: { 'gen-types': 'wrangler types --strict-vars false' }, ...wranglerPackageJson },
    {
      depending: genI18nTsDepending,
      isBun: true,
      isCloudflare: true,
      doesContainWranglerConfig: true,
      packageJson: wranglerPackageJson,
    },
    { createI18nDir: true }
  );

  expect(packageJson.scripts?.postinstall).toBe('wb gen-code && wrangler types --strict-vars false');
});

// Wrapper detection must survive environment assignments and runner flags around the script name.
test('detects generation through an env-prefixed wrapper postinstall', async () => {
  const wranglerPackageJson = { devDependencies: { wrangler: '4.42.0' } };
  const packageJson = await generatePackageJsonFrom(
    {
      scripts: {
        'gen:types': 'wrangler types --strict-vars=false',
        postinstall: 'NODE_ENV=production yarn run --silent gen:types',
      },
      ...wranglerPackageJson,
    },
    { isBun: true, isCloudflare: true, doesContainWranglerConfig: true, packageJson: wranglerPackageJson }
  );

  expect(packageJson.scripts?.postinstall).toBe('NODE_ENV=production yarn run --silent gen:types');
});

// `wrangler types --check` fails while the gitignored file is still absent, so the generator must run first.
test('prepends the generator to a check-only postinstall', async () => {
  const wranglerPackageJson = { devDependencies: { wrangler: '4.42.0' } };
  const packageJson = await generatePackageJsonFrom(
    { scripts: { postinstall: 'wrangler types --check' }, ...wranglerPackageJson },
    { isBun: true, isCloudflare: true, doesContainWranglerConfig: true, packageJson: wranglerPackageJson }
  );

  expect(packageJson.scripts?.postinstall).toBe('bunx wrangler types && wrangler types --check');
});

// A custom --config layout is not managed by wbfy, but the project's own generation — even behind a wrapper
// script — must survive the postinstall rewrite.
test('preserves a wrapper script invoking wrangler types with a custom config when overwriting postinstall', async () => {
  const wranglerPackageJson = { devDependencies: { wrangler: '4.42.0' } };
  const packageJson = await generatePackageJsonFrom(
    {
      scripts: {
        'gen-types': 'wrangler types --config config/worker.jsonc',
        postinstall: 'yarn gen-types',
      },
      ...wranglerPackageJson,
    },
    {
      depending: genI18nTsDepending,
      isBun: true,
      isCloudflare: true,
      doesContainWranglerConfig: false,
      packageJson: wranglerPackageJson,
    },
    { createI18nDir: true }
  );

  expect(packageJson.scripts?.postinstall).toBe('wb gen-code && yarn gen-types');
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
    'db-create-migration': 'wb db migrate-dev',
    'db-migrate': 'bun scripts/runDrizzleMigrationsToAllClients.ts',
    'db-view': 'wb db studio',
  });
});

test('uses bun runner for generated Python scripts in bun projects', async () => {
  const packageJson = await generatePackageJsonFrom(
    { scripts: {} },
    { doesContainUvLock: true, isBun: true },
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

test('preserves a leading MISE_ENV prefix on a mise bridge script', async () => {
  const packageJson = await generatePackageJsonFrom(
    {
      scripts: {
        test: 'MISE_ENV=test mise run test',
      },
    },
    { isBun: true, miseTasks: { test: 'bun run playwright test' } }
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
    { isBun: true, miseTasks: { test: 'bun run playwright test' } }
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
    { isBun: true, miseTasks: { test: 'bun run playwright test' } }
  );

  expect(packageJson.scripts?.test).toBe('mise run test');
});

test('never generates --bun scripts', async () => {
  const withPlaywright = await generatePackageJsonFrom(
    { scripts: {} },
    { isBun: true, depending: { ...createConfig().depending, playwrightTest: true } }
  );
  const withoutPlaywright = await generatePackageJsonFrom({ scripts: {} }, { isBun: true });

  expect(withPlaywright.scripts?.['verify-full']).toBe('bun wb verify --full');
  expect(withoutPlaywright.scripts?.['verify-full']).toBe('bun wb verify --full');
  for (const scripts of [withPlaywright.scripts, withoutPlaywright.scripts]) {
    for (const command of Object.values(scripts ?? {})) {
      expect(command).not.toContain('--bun');
    }
  }
});

test('type-checks in the lint script of TypeScript projects', { timeout: 60 * 1000 }, async () => {
  const withTypeScript = await generatePackageJsonFrom({ scripts: {} }, { doesContainTypeScript: true });
  const withoutTypeScript = await generatePackageJsonFrom({ scripts: {} }, { doesContainJavaScript: true });

  expect(withTypeScript.scripts?.lint).toBe('oxlint --type-aware --type-check --no-error-on-unmatched-pattern .');
  expect(withoutTypeScript.scripts?.lint).toBe('oxlint --no-error-on-unmatched-pattern .');
});

async function generatePackageJsonFrom(
  initialPackageJson: Record<string, unknown>,
  configOverrides: Parameters<typeof createConfig>[0] = {},
  options: { createI18nDir?: boolean; files?: Record<string, string> } = {}
): Promise<GeneratedPackageJson> {
  const dirPath = await fs.mkdtemp(path.join(os.tmpdir(), 'wbfy-package-json-'));
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
      ...configOverrides,
      dirPath,
    });
    await generatePackageJson(config, config, true);

    return JSON.parse(await fs.readFile(packageJsonPath, 'utf8')) as GeneratedPackageJson;
  } finally {
    await fs.rm(dirPath, { force: true, recursive: true });
  }
}
