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

  it('does not leak or clobber bookkeeping names and applies Bash readonly names via env', () => {
    const dirPath = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-apply-env-'));
    try {
      fs.writeFileSync(path.join(dirPath, '.docker.env'), "line='baked-line'\nUID='9999'\nOTHER='o'\n");
      const result = child_process.spawnSync('bash', [scriptPath, 'env'], {
        cwd: dirPath,
        encoding: 'utf8',
        // Inherited variables sharing the script's internal names must reach the child unchanged.
        env: { ...process.env, line: 'platform-line', value: 'platform-value', assignments: 'platform-a' },
      });
      expect(result.status).toBe(0);
      const envLines = result.stdout.split('\n');
      expect(envLines).toContain('line=platform-line');
      expect(envLines).toContain('value=platform-value');
      expect(envLines).toContain('assignments=platform-a');
      expect(envLines).toContain('OTHER=o');
      // A Bash readonly name is a valid baked key because values are passed via `env`.
      expect(envLines).toContain('UID=9999');
      expect(envLines.some((entry) => entry.startsWith('env_path=') || entry.startsWith('candidate='))).toBe(false);
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
