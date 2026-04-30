import childProcess from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, expect, test, vi } from 'vitest';

import type * as GitHubUtil from '../src/utils/githubUtil.js';

const { requestMock } = vi.hoisted(() => ({
  requestMock: vi.fn(),
}));

vi.mock('../src/utils/githubUtil.js', async (importOriginal) => {
  const actual = await importOriginal<typeof GitHubUtil>();
  return {
    ...actual,
    getOctokit: () => ({
      request: requestMock,
    }),
  };
});

import { getPackageConfig } from '../src/packageConfig.js';

afterEach(() => {
  vi.restoreAllMocks();
  requestMock.mockReset();
});

test('falls back to package repository when a stale remote cannot be verified', async () => {
  requestMock.mockImplementation((_route: string, params: { owner: string; repo: string }) => {
    if (params.owner === 'WillBooster') {
      throw { status: 404 };
    }
    return {
      data: {
        full_name: `${params.owner}/${params.repo}`,
        private: true,
      },
    };
  });

  const dirPath = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'wbfy-package-config-'));
  await fs.promises.writeFile(
    path.join(dirPath, 'package.json'),
    `${JSON.stringify(
      {
        repository: {
          type: 'git',
          url: 'git+https://github.com/WillBoosterLab/judge.git',
        },
      },
      undefined,
      2
    )}\n`
  );
  childProcess.execFileSync('git', ['init'], { cwd: dirPath, stdio: 'ignore' });
  childProcess.execFileSync('git', ['remote', 'add', 'origin', 'ssh://git@github.com/WillBooster/judge'], {
    cwd: dirPath,
    stdio: 'ignore',
  });

  const config = await getPackageConfig(dirPath);

  expect(config?.repository).toBe('github:WillBoosterLab/judge');
  expect(requestMock).toHaveBeenCalledTimes(2);
});
