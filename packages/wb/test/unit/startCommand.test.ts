import child_process from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'bun:test';

describe('wb start --help', () => {
  it('explains how to forward arguments after --', () => {
    const result = child_process.spawnSync('bun', ['run', 'start', 'start', '--help'], {
      cwd: process.cwd(),
      encoding: 'utf8',
    });
    const normalizedStdout = result.stdout.replaceAll(/\s+/g, ' ');

    expect(result.status).toBe(0);
    expect(normalizedStdout).toContain(`Use '--' to stop wb option parsing`);
    expect(normalizedStdout).toContain(`forward the remaining arguments to the underlying app command.`);
    expect(normalizedStdout).toContain(`Example: wb start -- --host 0.0.0.0`);
  });
});

describe('wb start --dry-run', () => {
  it('makes automatic browser opening optional', () => {
    const temporaryDir = path.join(process.cwd(), '.tmp');
    fs.mkdirSync(temporaryDir, { recursive: true });
    const fixtureDir = fs.mkdtempSync(path.join(temporaryDir, 'wb-start-'));
    const cliPath = fileURLToPath(new URL('../../src/index.ts', import.meta.url));
    fs.writeFileSync(
      path.join(fixtureDir, 'package.json'),
      JSON.stringify({ name: 'wb-start-fixture', packageManager: 'bun@1.4.2', dependencies: { next: '16.3.6' } })
    );

    try {
      const result = child_process.spawnSync(
        'bun',
        [cliPath, 'start', '--dry-run', '--auto-cascade-env=false', '--working-dir', fixtureDir],
        { encoding: 'utf8' }
      );

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('open-cli --optional');
    } finally {
      fs.rmSync(fixtureDir, { recursive: true, force: true });
    }
  });
});
