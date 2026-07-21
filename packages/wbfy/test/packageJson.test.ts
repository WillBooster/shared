import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { expect, test } from 'vitest';
import type { PackageJson } from 'type-fest';

import { generatePackageJson } from '../src/generators/packageJson.js';
import { createConfig } from './testConfig.js';

interface GeneratedPackageJson {
  dependencies?: Record<string, string | undefined>;
  devDependencies?: Record<string, string | undefined>;
  private?: boolean;
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
  ['an env-file generator', { postinstall: 'wrangler types --env-file .env.example' }],
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

// `wb gen-code` runs a BARE `wrangler types`, so a package whose own scripts pass flags that change the generated
// file must stay unmanaged: managing it would delete the only record of that choice and regenerate a different
// `Env`. --strict-vars=false widens `vars` to string; repeated -c pulls in service-binding/Durable Object RPC types.
test.each([
  ['strict-vars', { 'gen-types': 'wrangler types --strict-vars=false' }],
  ['multiple configs', { 'gen-types': 'wrangler types -c wrangler.jsonc -c ../bound/wrangler.jsonc' }],
  ['a custom output path', { 'gen-types': 'wrangler types --path src/env.d.ts' }],
])('leaves a package carrying %s unmanaged', async (_description, scripts) => {
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

  expect(packageJson.scripts?.['gen-types']).toBe(Object.values(scripts)[0]);
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

// wbfy gitignores and untracks worker-configuration.d.ts only where postinstall regenerates it, so a package that
// cannot run wrangler must not gain the install-time generation either.
test.each([
  ['the package does not depend on wrangler', {}, true, {}],
  ['the package owns no wrangler config', { devDependencies: { wrangler: '4.69.0' } }, false, {}],
  [
    // The temp directory is not a git repository, so the file counts as uncommitted, making the `Env` inference
    // irreproducible: wbfy must not manage a file CI would regenerate differently.
    'an uncommitted .dev.vars drives the Env inference',
    { devDependencies: { wrangler: '4.69.0' } },
    true,
    { '.dev.vars': 'AUTH_SECRET=local-secret\n', 'wrangler.jsonc': '{}' },
  ],
  [
    // Wranglers older than 4.70.0 warn about the unexpected top-level `secrets` field and keep inferring from
    // .dev.vars, so the declaration must not count as a reproducible inference source for them.
    'secrets.required predates the wrangler dependency support',
    { devDependencies: { wrangler: '4.69.0' } },
    true,
    { '.dev.vars': 'AUTH_SECRET=local-secret\n', 'wrangler.jsonc': `{ "secrets": { "required": ["AUTH_SECRET"] } }` },
  ],
])('omits the install-time generation when %s', async (_description, wranglerPackageJson, hasConfig, files) => {
  const packageJson = await generatePackageJsonFrom(
    { scripts: {}, ...wranglerPackageJson },
    { isCloudflare: true, doesContainWranglerConfig: hasConfig, packageJson: wranglerPackageJson },
    { files }
  );

  expect(packageJson.scripts?.postinstall).toBeUndefined();
});

// A `secrets.required` declaration at any config level replaces the .dev.vars/.env inference, making the generated
// declarations a pure function of committed inputs again. 4.70.0 is the first wrangler supporting it.
test.each([
  [
    'a top-level declaration',
    `{
      // JSONC comments and trailing commas must parse.
      "secrets": { "required": ["AUTH_SECRET"], },
    }`,
  ],
  ['an env-level declaration', `{ "env": { "staging": { "secrets": { "required": ["AUTH_SECRET"] } } } }`],
])('generates worker types on install when %s makes the Env inference reproducible', async (_description, config) => {
  const wranglerPackageJson = { devDependencies: { wrangler: '4.70.0' } };
  const packageJson = await generatePackageJsonFrom(
    { scripts: {}, ...wranglerPackageJson },
    { isCloudflare: true, doesContainWranglerConfig: true, packageJson: wranglerPackageJson },
    { files: { '.dev.vars': 'AUTH_SECRET=local-secret\n', 'wrangler.jsonc': config } }
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

test('converts yarn script invocations to bun while leaving Yarn built-ins untouched', async () => {
  const packageJson = await generatePackageJsonFrom({
    scripts: {
      'clean-all': 'yarn workspaces foreach --all exec rimraf dist',
      'deps-up': 'yarn up -R typescript',
      dollar: "yarn 'build:$target'",
      dynamic: 'yarn build:$target && yarn run "build:$target"',
      'quoted-assign': '"FOO=bar" yarn compile',
      'foreach-bare': 'yarn workspaces foreach run build',
      'fan-out': 'yarn workspaces foreach --all run build',
      'gen:sub': 'cd sub && yarn build:sub',
      hint: "echo 'run yarn build before deploying'",
      'install-note': "echo 'yarn install && deploy now'",
      mention: 'git commit -m yarn && echo yarn build',
      'parallel-dev': 'yarn workspaces foreach --all --parallel run dev',
      publish2: 'yarn npm publish --tolerate-republish',
      'quoted-install': "yarn 'install' && yarn compile",
      redirect: 'yarn build>out.log',
      'redirect-first': '>build.log yarn compile',
      'redirect-chain': 'yarn install > /dev/null && yarn format > /dev/null 2> /dev/null || true',
      'setup-all': 'yarn install && yarn compile',
      'since-build': 'yarn workspaces foreach --since run build',
      'ws-add': 'yarn workspace components add -D react',
      'ws-run': 'yarn workspace components run gen',
    },
  });

  expect(packageJson.scripts).toMatchObject({
    // Yarn built-ins have no bun run equivalent and must survive verbatim to surface in review.
    'clean-all': 'yarn workspaces foreach --all exec rimraf dist',
    'deps-up': 'yarn up -R typescript',
    publish2: 'yarn npm publish --tolerate-republish',
    'ws-add': 'yarn workspace components add -D react',
    // `yarn` inside a quoted token, in argument position, or after a quoted command word is data,
    // not a command.
    'quoted-assign': '"FOO=bar" yarn compile',
    hint: "echo 'run yarn build before deploying'",
    'install-note': "echo 'yarn install && deploy now'",
    mention: 'git commit -m yarn && echo yarn build',
    // Without an explicit --all/-A selection, `--filter '*'` would widen the fan-out.
    'foreach-bare': 'yarn workspaces foreach run build',
    // An unquoted expansion is dynamic: its runtime value could need Yarn's global routing.
    dynamic: 'yarn build:$target && yarn run "build:$target"',
    // A parallelism foreach flag keeps the yarn form: Bun's dependency-ordered concurrency could
    // block dependent long-running scripts forever.
    'parallel-dev': 'yarn workspaces foreach --all --parallel run dev',
    // A selection-restricting foreach flag keeps the yarn form: --filter '*' would widen it.
    'since-build': 'yarn workspaces foreach --since run build',
    // Script invocations are converted; quoted arguments are re-emitted verbatim so quoting and
    // expansion semantics never change.
    dollar: "bun run 'build:$target'",
    'fan-out': "bun run --filter '*' build",
    'gen:sub': 'cd sub && bun run build:sub',
    // A redirection ends the arguments driving the conversion and survives after the rewrite.
    redirect: 'bun run build>out.log',
    'redirect-first': '>build.log bun run compile',
    'redirect-chain': 'bun install > /dev/null && bun run format > /dev/null 2> /dev/null || true',
    // The legacy `yarn install && ` prefix is removed before conversion, quoted or not.
    'quoted-install': 'bun run compile',
    'setup-all': 'bun run compile',
    'ws-run': 'bun run --filter components gen',
  });
});

test('routes yarn colon global scripts to the workspace defining them', async () => {
  const packageJson = await generatePackageJsonFrom(
    {
      workspaces: ['packages/*'],
      scripts: {
        ':local-cache': 'echo local',
        at: 'yarn build:@scope',
        'cache-all': 'yarn build:cache',
        dot: 'yarn .build:cache',
        echoed: 'echo \'yarn build:cache\' && node warn.js "prefer yarn :build-caches"',
        flagged: 'yarn run --inspect-brk build:cache',
        'redir-target': 'yarn run >out.log build:cache',
        'require-flag': 'yarn run --require ./hook.cjs build:cache',
        local: 'yarn :local-cache',
        'local-flag': 'yarn run --silent :local-cache',
        missing: 'yarn :unknown-script && yarn run :unknown-script',
        quoted: `yarn ':build-caches' && yarn run ":build-caches"`,
        'test/ci-setup': 'build-ts run scripts/rename.ts && yarn :build-caches && sh scripts/install.sh',
        tools: 'yarn :tool-cache',
      },
    },
    { isRoot: true, doesContainSubPackageJsons: true },
    {
      files: {
        'packages/server/package.json': JSON.stringify({
          name: '@judge/server',
          scripts: {
            ':build-caches': 'echo build',
            '.build:cache': 'echo dot',
            'build:@scope': 'echo at',
            'build:cache': 'echo mid-colon',
          },
        }),
        'packages/tools/package.json': JSON.stringify({
          scripts: { ':tool-cache': 'echo tool' },
        }),
      },
    }
  );

  expect(packageJson.scripts).toMatchObject({
    // Script names are whole shell words, not just \w./:- characters.
    at: 'bun run --filter @judge/server build:@scope',
    // Yarn treats ANY colon-containing name as global, not only leading-colon ones.
    'cache-all': 'bun run --filter @judge/server build:cache',
    // Yarn's lookup has no first-character restriction, so dot-prefixed names resolve too.
    dot: 'bun run --filter @judge/server .build:cache',
    // `yarn ...` inside a quoted token is data, not a command; rewriting it would change the
    // script's output (or worse, inject a --filter route into a string literal).
    echoed: 'echo \'yarn build:cache\' && node warn.js "prefer yarn :build-caches"',
    // Flags between `run` and a target routed to ANOTHER workspace keep the yarn form: their
    // placement inside a --filter route is unmodeled.
    flagged: 'yarn run --inspect-brk build:cache',
    // A colon script defined in the invoking package stays a local bun run.
    local: 'bun run :local-cache',
    // Flags before a locally-defined target survive a plain `bun run` conversion.
    'local-flag': 'bun run --silent :local-cache',
    // A leading-colon script no workspace defines keeps its yarn form to surface in review.
    missing: 'yarn :unknown-script && yarn run :unknown-script',
    // A redirection ends the arguments driving the conversion, so the target behind it is unknown
    // and the invocation keeps its yarn form.
    'redir-target': 'yarn run >out.log build:cache',
    // The value consumed by `--require` is not the target; the routed target keeps the yarn form.
    'require-flag': 'yarn run --require ./hook.cjs build:cache',
    // A quoted script-name token is unquoted before colon-owner resolution, and re-emitted with
    // its original quoting so shell semantics never change.
    quoted: `bun run --filter @judge/server ':build-caches' && bun run --filter @judge/server ":build-caches"`,
    // A colon script defined in another workspace is routed there: bun has no global scripts.
    'test/ci-setup':
      'build-ts run scripts/rename.ts && bun run --filter @judge/server :build-caches && sh scripts/install.sh',
    // An unnamed workspace cannot be addressed with --filter (path filters resolve against the
    // invoking cwd), so its scripts run via --cwd relative to the invoking package.
    tools: "bun run --cwd 'packages/tools' :tool-cache",
  });
});

test('routes a root-owned colon global script invoked from a child workspace', async () => {
  const dirPath = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'wbfy-colon-root-')));
  try {
    const rootPackageJson = {
      name: 'root-pkg',
      workspaces: ['packages/*'],
      scripts: { ':root-cache': 'echo root' },
    };
    const childPackageJson = {
      name: '@x/child',
      scripts: {
        after: 'yarn :root-cache && cd dist && echo done',
        deep: 'cd src && yarn :root-cache',
        group: '{ cd src; yarn :root-cache; }',
        semi: 'echo setup; cd src; yarn :root-cache',
        warm: 'yarn :root-cache',
      },
    };
    await fs.writeFile(path.join(dirPath, 'package.json'), JSON.stringify(rootPackageJson));
    await fs.mkdir(path.join(dirPath, 'packages', 'child'), { recursive: true });
    const childPackageJsonPath = path.join(dirPath, 'packages', 'child', 'package.json');
    await fs.writeFile(childPackageJsonPath, JSON.stringify(childPackageJson));

    const rootConfig = createConfig({
      dirPath,
      isRoot: true,
      doesContainSubPackageJsons: true,
      packageJson: rootPackageJson,
    });
    const childConfig = createConfig({
      dirPath: path.join(dirPath, 'packages', 'child'),
      packageJson: childPackageJson,
    });
    await generatePackageJson(childConfig, rootConfig, true);

    const generated = JSON.parse(await fs.readFile(childPackageJsonPath, 'utf8')) as GeneratedPackageJson;
    // Bun's --filter never matches the workspace root, so root-owned scripts run via --cwd.
    expect(generated.scripts?.warm).toBe("bun run --cwd '../..' :root-cache");
    // A cd before the invocation would break the package-relative --cwd at runtime.
    expect(generated.scripts?.deep).toBe('cd src && yarn :root-cache');
    // The guard covers separators beyond && (e.g. `;`) and grouped commands too.
    expect(generated.scripts?.semi).toBe('echo setup; cd src; yarn :root-cache');
    expect(generated.scripts?.group).toBe('{ cd src; yarn :root-cache; }');
    // A cd after the invocation cannot affect it and must not prevent the conversion.
    expect(generated.scripts?.after).toBe("bun run --cwd '../..' :root-cache && cd dist && echo done");
  } finally {
    await fs.rm(dirPath, { force: true, recursive: true });
  }
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

test('strips `bun --bun` from user-authored scripts invoking Node-based tools', async () => {
  const packageJson = await generatePackageJsonFrom(
    {
      scripts: {
        build: 'bun --bun next build',
        dev: 'bun --bun next dev',
        start: 'bun --bun next start && bun --bun wrangler tail',
        'run-alias': 'bun --bun run build',
        'run-tool': 'bun --bun run next start',
        'quoted-executable': '"bun" --bun next build',
        multiline: 'bun --bun next build\nbun --bun wrangler tail',
        'env-prefix': 'NODE_ENV=production bun --bun next build',
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
  });
});

test('keeps `bun --bun` on direct script-file executions', async () => {
  const packageJson = await generatePackageJsonFrom(
    {
      scripts: {
        start: 'exec bun --bun src/index.ts',
        'start-chained': 'bun --bun src/index.ts;echo done',
        'start-quoted': 'bun --bun "src/index.ts"',
        'start-spaced-path': 'bun --bun "src/my script.ts"',
        'start-runtime-flags': 'bun --bun --smol src/index.ts',
        'start-variable': 'bun --bun "$ENTRYPOINT"',
        'start-run-file': 'bun --bun run ./src/index.ts',
        'start-extensionless': 'bun --bun ./scripts/server',
        'start-bare-file': 'bun --bun server',
        'start-run-missing': 'bun --bun run server',
        'start-quoted-flag': 'bun --bun run "--preload" ./setup.ts',
        'start-flag-value': 'bun --bun --cwd packages/app src/index.ts',
      },
    },
    {}
  );

  expect(packageJson.scripts).toMatchObject({
    start: 'exec bun --bun src/index.ts',
    'start-chained': 'bun --bun src/index.ts;echo done',
    'start-quoted': 'bun --bun "src/index.ts"',
    'start-spaced-path': 'bun --bun "src/my script.ts"',
    'start-runtime-flags': 'bun --bun --smol src/index.ts',
    'start-variable': 'bun --bun "$ENTRYPOINT"',
    'start-run-file': 'bun --bun run ./src/index.ts',
    'start-extensionless': 'bun --bun ./scripts/server',
    'start-bare-file': 'bun --bun server',
    'start-run-missing': 'bun --bun run server',
    'start-quoted-flag': 'bun --bun run "--preload" ./setup.ts',
    'start-flag-value': 'bun --bun --cwd packages/app src/index.ts',
  });
});

test('does not rewrite `bun --bun` outside a command position', async () => {
  const packageJson = await generatePackageJsonFrom(
    {
      scripts: {
        'echo-literal': 'echo "bun --bun next build"',
        'nested-literal': `node -e 'console.log("use bun --bun next")'`,
        'other-tool': 'my-bun --bun next build',
      },
    },
    {}
  );

  expect(packageJson.scripts).toMatchObject({
    'echo-literal': 'echo "bun --bun next build"',
    'nested-literal': `node -e 'console.log("use bun --bun next")'`,
    'other-tool': 'my-bun --bun next build',
  });
});

async function generatePackageJsonFrom(
  initialPackageJson: Record<string, unknown>,
  configOverrides: Parameters<typeof createConfig>[0] = {},
  options: { createI18nDir?: boolean; files?: Record<string, string> } = {}
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
    await generatePackageJson(config, config, true);

    return JSON.parse(await fs.readFile(packageJsonPath, 'utf8')) as GeneratedPackageJson;
  } finally {
    await fs.rm(dirPath, { force: true, recursive: true });
  }
}
