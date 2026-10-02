import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { spawnAsync } from '@willbooster/shared-lib-node/src';
import { beforeAll, describe, expect, it } from 'bun:test';

import { getGenCodeScripts } from '../../src/commands/genCode.js';
import { Project } from '../../src/project.js';
import { buildWb } from '../helpers/build.js';

const cliPath = path.resolve('bin/index.js');

beforeAll(buildWb, 120_000);

// `wrangler types` reads its secret key names from the stub generateWorkerTypesEnvStub writes; the
// script here just points wrangler at that stub via --env-file.
const WORKER_TYPES_ENV = path.join('.wrangler', 'worker-types.env');
const WRANGLER_TYPES = `YARN wrangler types --env-file ${WORKER_TYPES_ENV} < /dev/null`;

describe('getGenCodeScripts', () => {
  it('generates worker types first, before the other generators', async () => {
    const dirPath = await createWorkerProject({ devDependencies: { wrangler: '4.70.0' } }, true);

    try {
      // Worker types must precede the later generators because worker-configuration.d.ts is gitignored
      // and they type-check against the `Env` it declares. --env-file points wrangler at the key stub.
      expect(getGenCodeScripts(new Project(dirPath, {}, false))[0]).toBe(WRANGLER_TYPES);
    } finally {
      await fs.rm(dirPath, { force: true, recursive: true });
    }
  });

  it('does not generate worker types without an own wrangler dependency', async () => {
    const dirPath = await createWorkerProject({}, true);

    try {
      expect(getGenCodeScripts(new Project(dirPath, {}, false))).not.toContain(WRANGLER_TYPES);
    } finally {
      await fs.rm(dirPath, { force: true, recursive: true });
    }
  });

  it('does not generate worker types the project does not consume', async () => {
    // No gitignore entry means wbfy left the package unmanaged because its tsconfig cannot
    // reference the file (e.g. a hand-maintained Env), so generating it would only leave an
    // untracked ~500KB file behind.
    const dirPath = await createWorkerProject({ devDependencies: { wrangler: '4.70.0' } }, false);

    try {
      expect(getGenCodeScripts(new Project(dirPath, {}, false))).not.toContain(WRANGLER_TYPES);
    } finally {
      await fs.rm(dirPath, { force: true, recursive: true });
    }
  });

  it('generates worker types despite an env-file invocation naming an existing file', async () => {
    // gen-code's own `--env-file` stub (derived from the committed fnox.toml) replaces the dotenv inference,
    // so an env-file-only invocation is equivalent to the managed generation. Local file existence must not
    // change the answer, or this predicate would disagree with wbfy's across machines.
    const dirPath = await createWorkerProject(
      { devDependencies: { wrangler: '4.70.0' }, scripts: { 'gen-types': 'wrangler types --env-file custom.env' } },
      true
    );
    await fs.writeFile(path.join(dirPath, 'custom.env'), 'API_KEY=\n');

    try {
      expect(getGenCodeScripts(new Project(dirPath, {}, false))).toContain(WRANGLER_TYPES);
    } finally {
      await fs.rm(dirPath, { force: true, recursive: true });
    }
  });

  it('generates canonical worker types despite an output-changing project invocation', async () => {
    const dirPath = await createWorkerProject(
      { devDependencies: { wrangler: '4.70.0' }, scripts: { 'gen-types': 'wrangler types --strict-vars=false' } },
      true
    );

    try {
      expect(getGenCodeScripts(new Project(dirPath, {}, false))).toContain(WRANGLER_TYPES);
    } finally {
      await fs.rm(dirPath, { force: true, recursive: true });
    }
  });

  it('runs the project gen-i18n-ts script when it exists', async () => {
    const dirPath = await createProject({
      scripts: {
        'gen-i18n-ts': 'gen-i18n-ts -i locales -o src/i18n.ts -d en-US',
      },
    });
    await fs.mkdir(path.join(dirPath, 'src'));

    try {
      expect(getGenCodeScripts(new Project(dirPath, {}, false))).toContain('YARN run gen-i18n-ts');
    } finally {
      await fs.rm(dirPath, { force: true, recursive: true });
    }
  });

  it('runs the default gen-i18n-ts command when the package and i18n directory exist', async () => {
    const dirPath = await createProject({
      dependencies: {
        'gen-i18n-ts': '4.0.6',
      },
    });
    await fs.mkdir(path.join(dirPath, 'i18n'));
    await fs.mkdir(path.join(dirPath, 'src'));

    try {
      expect(getGenCodeScripts(new Project(dirPath, {}, false))).toContain(
        'YARN gen-i18n-ts -i i18n -o src/__generated__/i18n.ts -d ja-JP'
      );
    } finally {
      await fs.rm(dirPath, { force: true, recursive: true });
    }
  });

  it('does not run the default gen-i18n-ts command without an i18n directory', async () => {
    const dirPath = await createProject({
      dependencies: {
        'gen-i18n-ts': '4.0.6',
      },
    });

    try {
      expect(getGenCodeScripts(new Project(dirPath, {}, false))).not.toContain(
        'YARN gen-i18n-ts -i i18n -o src/__generated__/i18n.ts -d ja-JP'
      );
    } finally {
      await fs.rm(dirPath, { force: true, recursive: true });
    }
  });

  it('does not run the default gen-i18n-ts command without source code', async () => {
    const dirPath = await createProject({
      dependencies: {
        'gen-i18n-ts': '4.0.6',
      },
    });
    await fs.mkdir(path.join(dirPath, 'i18n'));

    try {
      expect(getGenCodeScripts(new Project(dirPath, {}, false))).not.toContain(
        'YARN gen-i18n-ts -i i18n -o src/__generated__/i18n.ts -d ja-JP'
      );
    } finally {
      await fs.rm(dirPath, { force: true, recursive: true });
    }
  });

  it('does not run the project gen-i18n-ts script without source code', async () => {
    const dirPath = await createProject({
      scripts: {
        'gen-i18n-ts': 'gen-i18n-ts -i locales -o src/i18n.ts -d en-US',
      },
    });

    try {
      expect(getGenCodeScripts(new Project(dirPath, {}, false))).not.toContain('YARN run gen-i18n-ts');
    } finally {
      await fs.rm(dirPath, { force: true, recursive: true });
    }
  });

  it('runs prisma generate when the schema exists', async () => {
    const dirPath = await createProject({
      dependencies: {
        prisma: '6.0.0',
      },
    });
    await fs.mkdir(path.join(dirPath, 'prisma'));
    await fs.writeFile(path.join(dirPath, 'prisma', 'schema.prisma'), '');

    try {
      expect(getGenCodeScripts(new Project(dirPath, {}, false))).toContain('PRISMA generate');
    } finally {
      await fs.rm(dirPath, { force: true, recursive: true });
    }
  });

  it('runs blitz codegen before prisma generate for yarn-era Blitz repositories', async () => {
    const dirPath = await createProject({
      packageManager: 'yarn@4.17.0',
      dependencies: { blitz: '2.2.4', prisma: '6.0.0' },
    });
    await fs.mkdir(path.join(dirPath, 'src'));
    await fs.mkdir(path.join(dirPath, 'db'));
    await fs.writeFile(path.join(dirPath, 'db', 'schema.prisma'), '');

    try {
      const scripts = getGenCodeScripts(new Project(dirPath, {}, false));
      expect(scripts).toContain('YARN blitz codegen');
      expect(scripts.indexOf('YARN blitz codegen')).toBeLessThan(scripts.indexOf('PRISMA generate'));
    } finally {
      await fs.rm(dirPath, { force: true, recursive: true });
    }
  });

  it('does not run blitz codegen for Bun-managed Blitz repositories', async () => {
    // The blitz CLI patches the installed next package in place; Bun-managed repositories get an
    // empty route manifest from gen-code instead.
    const dirPath = await createProject({ dependencies: { blitz: '2.2.4' } });
    await fs.mkdir(path.join(dirPath, 'src'));
    await fs.writeFile(path.join(dirPath, 'bun.lock'), '');

    try {
      expect(getGenCodeScripts(new Project(dirPath, {}, false))).not.toContain('YARN blitz codegen');
    } finally {
      await fs.rm(dirPath, { force: true, recursive: true });
    }
  });

  it('does not run prisma generate without a schema', async () => {
    const dirPath = await createProject({
      dependencies: {
        prisma: '6.0.0',
      },
    });

    try {
      expect(getGenCodeScripts(new Project(dirPath, {}, false))).not.toContain('PRISMA generate');
    } finally {
      await fs.rm(dirPath, { force: true, recursive: true });
    }
  });
});

describe('wb gen-code', () => {
  it("writes the Blitz route manifest stub into the workspace root's node_modules, keeping existing files", async () => {
    const dirPath = await createProject({ name: 'root', private: true, workspaces: ['packages/*'] });
    await fs.writeFile(path.join(dirPath, 'bun.lock'), '');
    const appDirPath = path.join(dirPath, 'packages', 'app');
    await fs.mkdir(appDirPath, { recursive: true });
    await fs.writeFile(
      path.join(appDirPath, 'package.json'),
      JSON.stringify({ name: 'app', dependencies: { '@blitzjs/next': '2.2.4' } })
    );
    const manifestDirPath = path.join(dirPath, 'node_modules', '.blitz');
    await fs.mkdir(manifestDirPath, { recursive: true });
    await fs.writeFile(path.join(manifestDirPath, 'index.js'), 'exports.Routes = { Home: 1 };\n');

    try {
      const result = await spawnAsync('node', [cliPath, 'gen-code'], { cwd: dirPath, timeout: 30_000 });
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(await fs.readFile(path.join(manifestDirPath, 'index.js'), 'utf8')).toBe('exports.Routes = { Home: 1 };\n');
      expect(await fs.readFile(path.join(manifestDirPath, 'index-browser.js'), 'utf8')).toBe('exports.Routes = {};\n');
      expect(await fs.readFile(path.join(manifestDirPath, 'index.d.ts'), 'utf8')).toBe(
        'export declare const Routes: Record<string, never>;\n'
      );
      expect(await fs.readdir(appDirPath)).toEqual(['package.json']);
    } finally {
      await fs.rm(dirPath, { force: true, recursive: true });
    }
  }, 60_000);
});

async function createProject(packageJson: Record<string, unknown>): Promise<string> {
  const dirPath = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-gen-code-'));
  await fs.writeFile(path.join(dirPath, 'package.json'), JSON.stringify(packageJson));
  return dirPath;
}

/**
 * The package's committed gitignore rule is the signal that it consumes the generated file.
 */
async function createWorkerProject(packageJson: Record<string, unknown>, ignoresWorkerTypes: boolean): Promise<string> {
  const dirPath = await createProject(packageJson);
  await fs.writeFile(path.join(dirPath, 'wrangler.jsonc'), '{}');
  if (ignoresWorkerTypes) {
    // The exact rule wbfy generates; an anchored path is what marks the package as managed.
    await fs.writeFile(path.join(dirPath, '.gitignore'), '/worker-configuration.d.ts\n');
  }
  return dirPath;
}
