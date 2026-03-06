import { describe, expect, it } from 'vitest';

import { runConcurrently } from '../src/commands/concurrently.js';

describe('runConcurrently', () => {
  const env = process.env as Record<string, string | undefined>;

  it('returns success when all commands succeed', async () => {
    const exitCode = await runConcurrently({
      commands: [
        `${process.execPath} -e "setTimeout(() => process.exit(0), 50)"`,
        `${process.execPath} -e "setTimeout(() => process.exit(0), 100)"`,
      ],
      cwd: process.cwd(),
      env,
      killOthers: false,
      killOthersOnFail: false,
      success: 'all',
    });

    expect(exitCode).toBe(0);
  });

  it('returns success when the first exiting command succeeds with success=first', async () => {
    const exitCode = await runConcurrently({
      commands: [
        `${process.execPath} -e "setTimeout(() => process.exit(0), 120)"`,
        `${process.execPath} -e "setTimeout(() => process.exit(0), 50)"`,
      ],
      cwd: process.cwd(),
      env,
      killOthers: true,
      killOthersOnFail: false,
      success: 'first',
    });

    expect(exitCode).toBe(0);
  });

  it('returns failure when one command fails with kill-others-on-fail', async () => {
    const exitCode = await runConcurrently({
      commands: [
        `${process.execPath} -e "setTimeout(() => process.exit(1), 40)"`,
        `${process.execPath} -e "setTimeout(() => process.exit(0), 1000)"`,
      ],
      cwd: process.cwd(),
      env,
      killOthers: false,
      killOthersOnFail: true,
      success: 'all',
    });

    expect(exitCode).not.toBe(0);
  });
});
