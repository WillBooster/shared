import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { spawnAsync } from '@willbooster/shared-lib-node/src';
import { describe, expect, it, setDefaultTimeout } from 'bun:test';

// Every test runs the CLI from source in a child process, which took up to 2.7 seconds on CI.
setDefaultTimeout(30_000);

describe('wb start --help', () => {
  it('explains how to forward arguments after --', async () => {
    const result = await spawnAsync('bun', ['run', 'start', 'start', '--help'], { cwd: process.cwd() });
    const normalizedStdout = result.stdout.replaceAll(/\s+/g, ' ');

    expect(result.status).toBe(0);
    expect(normalizedStdout).toContain(`Use '--' to stop wb option parsing`);
    expect(normalizedStdout).toContain(`forward the remaining arguments to the underlying app command.`);
    expect(normalizedStdout).toContain(`Example: wb start -- --host 0.0.0.0`);
  });
});

describe('wb start --dry-run', () => {
  it('makes automatic browser opening optional', async () => {
    const temporaryDir = path.join(process.cwd(), '.tmp');
    fs.mkdirSync(temporaryDir, { recursive: true });
    const fixtureDir = fs.mkdtempSync(path.join(temporaryDir, 'wb-start-'));
    const cliPath = fileURLToPath(new URL('../../src/index.ts', import.meta.url));
    fs.writeFileSync(
      path.join(fixtureDir, 'package.json'),
      JSON.stringify({ name: 'wb-start-fixture', packageManager: 'bun@1.4.2', dependencies: { next: '16.3.6' } })
    );

    try {
      const result = await spawnAsync('bun', [
        cliPath,
        'start',
        '--dry-run',
        '--auto-cascade-env=false',
        '--working-dir',
        fixtureDir,
      ]);

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('open-cli --optional');
    } finally {
      fs.rmSync(fixtureDir, { recursive: true, force: true });
    }
  });
});
