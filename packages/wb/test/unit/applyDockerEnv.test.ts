import child_process from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const scriptPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../docker/bash/apply-docker-env.sh');

describe('apply-docker-env.sh', () => {
  it('applies baked values only to keys the environment does not already provide', () => {
    const dirPath = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-apply-env-'));
    try {
      fs.writeFileSync(path.join(dirPath, '.docker.env'), "BAKED_ONLY='baked'\nOVERRIDDEN='baked'\nnot a valid line\n");
      const result = child_process.spawnSync('bash', [scriptPath, 'sh', '-c', 'echo "$BAKED_ONLY/$OVERRIDDEN"'], {
        cwd: dirPath,
        encoding: 'utf8',
        env: { ...process.env, OVERRIDDEN: 'from-environment' },
      });
      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe('baked/from-environment');
    } finally {
      fs.rmSync(dirPath, { recursive: true, force: true });
    }
  });

  it('keeps a deliberately empty platform value and reads a final line without a trailing newline', () => {
    const dirPath = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-apply-env-'));
    try {
      fs.writeFileSync(path.join(dirPath, '.docker.env'), "EMPTY_ON_PLATFORM='baked'\nLAST='last'");
      const result = child_process.spawnSync('bash', [scriptPath, 'sh', '-c', 'echo "[$EMPTY_ON_PLATFORM][$LAST]"'], {
        cwd: dirPath,
        encoding: 'utf8',
        env: { ...process.env, EMPTY_ON_PLATFORM: '' },
      });
      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe('[][last]');
    } finally {
      fs.rmSync(dirPath, { recursive: true, force: true });
    }
  });

  it('execs the command unchanged when no env file exists', () => {
    const dirPath = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-apply-env-'));
    try {
      const result = child_process.spawnSync('bash', [scriptPath, 'echo', 'ok'], { cwd: dirPath, encoding: 'utf8' });
      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe('ok');
    } finally {
      fs.rmSync(dirPath, { recursive: true, force: true });
    }
  });
});
