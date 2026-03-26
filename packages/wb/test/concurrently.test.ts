import { describe, expect, it } from 'vitest';

import { runConcurrently } from '../src/commands/concurrently.js';

describe('runConcurrently', () => {
  const env = process.env as Record<string, string | undefined>;
  const cwd = process.cwd();

  it('returns success when all commands succeed', async () => {
    const exitCode = await runConcurrently({
      commands: [
        `${process.execPath} -e "setTimeout(() => process.exit(0), 50)"`,
        `${process.execPath} -e "setTimeout(() => process.exit(0), 100)"`,
      ],
      cwd,
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
      cwd,
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
      cwd,
      env,
      killOthers: false,
      killOthersOnFail: true,
      success: 'all',
    });

    expect(exitCode).not.toBe(0);
  });

  it('returns failure when the first exiting command fails with success=first', async () => {
    const exitCode = await runConcurrently({
      commands: [
        `${process.execPath} -e "setTimeout(() => process.exit(0), 120)"`,
        `${process.execPath} -e "setTimeout(() => process.exit(1), 40)"`,
      ],
      cwd,
      env,
      killOthers: false,
      killOthersOnFail: false,
      success: 'first',
    });

    expect(exitCode).toBe(1);
  });

  it('does not stop other commands when kill-others-on-fail is enabled but the first exit succeeds', async () => {
    const startedAt = Date.now();
    const exitCode = await runConcurrently({
      commands: [
        `${process.execPath} -e "setTimeout(() => process.exit(0), 40)"`,
        `${process.execPath} -e "setTimeout(() => process.exit(0), 180)"`,
      ],
      cwd,
      env,
      killOthers: false,
      killOthersOnFail: true,
      success: 'all',
    });

    expect(exitCode).toBe(0);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(120);
  });

  it('maps signal exits to 128 plus the signal number', async () => {
    const exitCode = await runConcurrently({
      commands: ['kill -TERM $$'],
      cwd,
      env,
      killOthers: false,
      killOthersOnFail: false,
      success: 'all',
    });

    expect(exitCode).toBe(143);
  });
});
