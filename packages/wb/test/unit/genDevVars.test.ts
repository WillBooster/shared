import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { writeEnvVarsFile } from '../../src/commands/genDevVars.js';
import { Project } from '../../src/project.js';

describe('writeEnvVarsFile', () => {
  it('emits a key-only stub for types: every declared key, including empty placeholders, with a placeholder value', async () => {
    const dirPath = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-gen-dev-vars-'));
    await fs.writeFile(path.join(dirPath, 'package.json'), '{}');
    // A base .env whose keys `wrangler types` would read natively; --env-file replaces that reading,
    // so the stub must carry them. EMPTY_PLACEHOLDER has no value but still declares a binding.
    await fs.writeFile(path.join(dirPath, '.env'), 'FILLED_SECRET=real-value\nEMPTY_PLACEHOLDER=\n');
    const outputPath = path.join(dirPath, '.wrangler', 'worker-types.env');

    try {
      writeEnvVarsFile(new Project(dirPath, {}, false), { autoCascadeEnv: true }, { outputPath, forTypes: true });

      const content = await fs.readFile(outputPath, 'utf8');
      // Both keys are typed, and the real value is replaced by the constant placeholder — so no secret
      // reaches disk and quoteDotenvValue (which can throw) is never invoked.
      expect(content).toContain('EMPTY_PLACEHOLDER=1');
      expect(content).toContain('FILLED_SECRET=1');
      expect(content).not.toContain('real-value');
    } finally {
      await fs.rm(dirPath, { force: true, recursive: true });
    }
  });

  it('writes a runtime .dev.vars with real values and drops empty placeholders', async () => {
    const dirPath = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-gen-dev-vars-'));
    await fs.writeFile(path.join(dirPath, 'package.json'), '{}');
    await fs.writeFile(path.join(dirPath, '.env'), 'FILLED_SECRET=real-value\nEMPTY_PLACEHOLDER=\n');
    const outputPath = path.join(dirPath, '.dev.vars');

    try {
      writeEnvVarsFile(new Project(dirPath, {}, false), { autoCascadeEnv: true }, { outputPath, forTypes: false });

      const content = await fs.readFile(outputPath, 'utf8');
      // The real value is written (quoteDotenvValue may quote it), not the type-stub placeholder.
      expect(content).toContain('real-value');
      expect(content).not.toContain('FILLED_SECRET=1');
      // An empty `KEY=` placeholder must not shadow a wrangler `vars` entry with an empty string.
      expect(content).not.toContain('EMPTY_PLACEHOLDER');
    } finally {
      await fs.rm(dirPath, { force: true, recursive: true });
    }
  });
});
