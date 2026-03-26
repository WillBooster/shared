import child_process from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, afterEach, vi } from 'vitest';

import { concurrentlyCommand, runConcurrently } from '../src/commands/concurrently.js';

describe('runConcurrently', () => {
  const env = process.env as Record<string, string | undefined>;
  const cwd = process.cwd();

  afterEach(() => {
    vi.restoreAllMocks();
  });

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
    const markerFilePath = path.join(
      os.tmpdir(),
      `wb-concurrently-${process.pid}-${Math.random().toString(36).slice(2)}.txt`
    );
    const writeMarkerScript = `setTimeout(() => { require('node:fs').writeFileSync(${JSON.stringify(markerFilePath)}, 'done'); process.exit(0); }, 180)`;
    const exitCode = await runConcurrently({
      commands: [
        `${process.execPath} -e "setTimeout(() => process.exit(0), 40)"`,
        `${process.execPath} -e ${JSON.stringify(writeMarkerScript)}`,
      ],
      cwd,
      env,
      killOthers: false,
      killOthersOnFail: true,
      success: 'all',
    });

    expect(exitCode).toBe(0);
    expect(fs.existsSync(markerFilePath)).toBe(true);
    await fs.promises.rm(markerFilePath, { force: true });
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

  it('returns failure when a child process emits an error', async () => {
    vi.spyOn(child_process, 'spawn').mockImplementation(() => {
      const listeners = new Map<string, ((...args: unknown[]) => void)[]>();
      const child = {
        once(event: string, listener: (...args: unknown[]) => void) {
          listeners.set(event, [...(listeners.get(event) ?? []), listener]);
          return child;
        },
      } as unknown as child_process.ChildProcess;

      queueMicrotask(() => {
        for (const listener of listeners.get('error') ?? []) {
          listener(new Error('spawn failed'));
        }
      });
      return child;
    });

    await expect(
      runConcurrently({
        commands: ['ignored'],
        cwd,
        env,
        killOthers: false,
        killOthersOnFail: false,
        success: 'all',
      })
    ).resolves.toBe(1);
  });
});

describe('concurrentlyCommand', () => {
  it('registers shared env-loading options', () => {
    const builder = concurrentlyCommand.builder as Record<string, unknown>;
    expect(builder.env).toBeDefined();
    expect(builder['cascade-env']).toBeDefined();
    expect(builder['include-root-env']).toBeDefined();
    expect(builder.verbose).toBeDefined();
  });
});
