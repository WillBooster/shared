import child_process from 'node:child_process';

import { describe, expect, it } from 'vitest';

describe('wb start --help', () => {
  it('explains how to forward arguments after --', () => {
    const result = child_process.spawnSync('yarn', ['workspace', '@willbooster/wb', 'start', 'start', '--help'], {
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
