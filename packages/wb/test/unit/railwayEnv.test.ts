import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { prepareRailwayCli, selectRailwayVariables } from '../../src/commands/railwayEnv.js';
import { selectFnoxSourcedKeys } from '../../src/utils/envSources.js';

describe('prepareRailwayCli', () => {
  it('reinstalls an incomplete bunx environment once', async () => {
    const testId = `wb-test-${crypto.randomUUID()}`;
    const installDirPath = path.join(os.tmpdir(), `bunx-${process.getuid!()}-@railway`, `cli@${testId}`);
    const binaryPath = path.join(installDirPath, 'node_modules', '@railway', 'cli', 'bin', 'railway');
    await fs.mkdir(path.dirname(binaryPath), { recursive: true });
    await fs.writeFile(path.join(installDirPath, 'incomplete'), 'true');
    const fakeBunx = await createFakeBunx(binaryPath);

    try {
      const result = await prepareRailwayCli(fakeBunx.dirPath, fakeBunx.env);

      expect(result.status).toBe(0);
      expect(await fs.readFile(fakeBunx.statePath, 'utf8')).toBe('2');
      await expect(fs.stat(installDirPath)).rejects.toThrow();
    } finally {
      await fs.rm(fakeBunx.dirPath, { force: true, recursive: true });
      await fs.rm(installDirPath, { force: true, recursive: true });
    }
  });

  it('does not remove a path outside the Railway CLI bunx environment', async () => {
    const unrelatedDirPath = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-railway-unrelated-'));
    const binaryPath = path.join(unrelatedDirPath, 'node_modules', '@railway', 'cli', 'bin', 'railway');
    await fs.mkdir(path.dirname(binaryPath), { recursive: true });
    const fakeBunx = await createFakeBunx(binaryPath);

    try {
      const result = await prepareRailwayCli(fakeBunx.dirPath, fakeBunx.env);

      expect(result.status).toBe(127);
      expect(await fs.readFile(fakeBunx.statePath, 'utf8')).toBe('1');
      await expect(fs.stat(unrelatedDirPath)).resolves.toBeDefined();
    } finally {
      await fs.rm(fakeBunx.dirPath, { force: true, recursive: true });
      await fs.rm(unrelatedDirPath, { force: true, recursive: true });
    }
  });
});

describe('selectFnoxSourcedKeys', () => {
  it('keeps fnox-declared keys and drops mise-provided host/tool variables', () => {
    const keys = selectFnoxSourcedKeys([
      ['fnox export --profile production', ['DATABASE_URL', 'DISCORD_BOT_TOKEN', 'PORT']],
      ['mise env --env production', ['PATH', 'CARGO_HOME', 'RUSTUP_HOME', 'RUSTUP_TOOLCHAIN']],
    ]);
    expect([...keys].toSorted()).toEqual(['DATABASE_URL', 'DISCORD_BOT_TOKEN', 'PORT']);
  });
});

describe('selectRailwayVariables', () => {
  it('keeps declared app variables (incl. DATABASE_URL/PORT), drops empty and Railway-managed keys, and sorts', () => {
    expect(
      selectRailwayVariables({
        DISCORD_BOT_TOKEN: 'secret',
        DATABASE_URL: 'file:/data/app.sqlite',
        PORT: '8080',
        NEXT_PUBLIC_BASE_URL: 'https://example.com',
        // fnox is the source of truth, so app values win — but blanks and Railway/system keys never push.
        EMPTY_PLACEHOLDER: '',
        UNRESOLVED: undefined,
        CI: 'true',
        RAILWAY_PROJECT_ID: 'proj-1',
        RAILWAY_SERVICE_ID: 'svc-1',
        NIXPACKS_NODE_VERSION: '24',
        WB_ENV: 'production',
      })
    ).toEqual([
      ['DATABASE_URL', 'file:/data/app.sqlite'],
      ['DISCORD_BOT_TOKEN', 'secret'],
      ['NEXT_PUBLIC_BASE_URL', 'https://example.com'],
      ['PORT', '8080'],
      ['WB_ENV', 'production'],
    ]);
  });

  it('returns nothing when every value is empty, missing, or Railway-managed', () => {
    expect(
      selectRailwayVariables({ EMPTY: '', MISSING: undefined, RAILWAY_ENVIRONMENT: 'production', CI: '1' })
    ).toEqual([]);
  });
});

interface FakeBunx {
  dirPath: string;
  env: NodeJS.ProcessEnv;
  statePath: string;
}

async function createFakeBunx(binaryPath: string): Promise<FakeBunx> {
  const dirPath = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-railway-env-'));
  const binDirPath = path.join(dirPath, 'bin');
  const statePath = path.join(dirPath, 'attempts');
  await fs.mkdir(binDirPath, { recursive: true });
  await fs.writeFile(
    path.join(binDirPath, 'bunx'),
    `#!/usr/bin/env node
const fs = require('node:fs');
const attempts = Number(fs.readFileSync(process.env.FAKE_BUNX_STATE, 'utf8') || '0') + 1;
fs.writeFileSync(process.env.FAKE_BUNX_STATE, String(attempts));
if (attempts === 1) {
  console.error(\`railway: could not find the CLI binary at \${process.env.FAKE_BUNX_BINARY_PATH}\`);
  process.exit(127);
}
console.log('railway 1.0.0');
`
  );
  await fs.chmod(path.join(binDirPath, 'bunx'), 0o755);
  await fs.writeFile(statePath, '0');
  return {
    dirPath,
    env: {
      ...process.env,
      FAKE_BUNX_BINARY_PATH: binaryPath,
      FAKE_BUNX_STATE: statePath,
      PATH: `${binDirPath}:${process.env.PATH}`,
    },
    statePath,
  };
}
