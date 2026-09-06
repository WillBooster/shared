import fs from 'node:fs';
import path from 'node:path';

import { expect, test } from 'bun:test';

/**
 * Runs the command over the given home-directory files and returns its exit code together with the
 * same files as it left them. The command resolves every path from os.homedir(), which Bun fixes at
 * process start, so it runs in a subprocess whose HOME is the scratch directory holding the files.
 */
async function generateUserAgentConfigs(files: Record<string, string>): Promise<{
  exitCode: number;
  files: Record<string, string>;
}> {
  const tempRootPath = path.join(process.cwd(), '.tmp');
  await fs.promises.mkdir(tempRootPath, { recursive: true });
  const homePath = await fs.promises.mkdtemp(path.join(tempRootPath, 'user-agent-configs-'));
  try {
    for (const [relativePath, content] of Object.entries(files)) {
      const filePath = path.join(homePath, relativePath);
      await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
      await fs.promises.writeFile(filePath, content);
    }
    const commandPath = path.join(import.meta.dir, '../../src/index.ts');
    const spawned = Bun.spawn(['bun', commandPath, 'generate-user-agent-configs'], {
      env: { ...Bun.env, HOME: homePath },
      stderr: 'pipe',
      stdout: 'pipe',
    });
    const exitCode = await spawned.exited;
    const generatedFiles: Record<string, string> = {};
    for (const relativePath of Object.keys(files)) {
      generatedFiles[relativePath] = await fs.promises.readFile(path.join(homePath, relativePath), 'utf8');
    }
    return { exitCode, files: generatedFiles };
  } finally {
    await fs.promises.rm(homePath, { force: true, recursive: true });
  }
}

test('merges the memory setting into a commented Gemini settings file', async () => {
  const { exitCode, files } = await generateUserAgentConfigs({
    '.gemini/settings.json': '{\n  // chosen when signing in\n  "security": { "auth": {} }\n}\n',
  });

  expect(exitCode).toBe(0);
  const content = files['.gemini/settings.json'] ?? '';
  expect(JSON.parse(content.replaceAll(/^\s*\/\/.*$/gmu, ''))).toEqual({
    experimental: { autoMemory: false },
    security: { auth: {} },
  });
  expect(content).toContain('// chosen when signing in');
});

test('leaves a commented Claude settings file to the developer', async () => {
  const original = '{\n  // keep the fancy prompt\n  "statusLine": { "type": "command", "command": "echo hi" }\n}\n';
  const { exitCode, files } = await generateUserAgentConfigs({ '.claude/settings.json': original });

  expect(exitCode).toBe(1);
  expect(files['.claude/settings.json']).toBe(original);
});

test('leaves a settings file with a trailing comma to the developer', async () => {
  const original = '{\n  "security": { "auth": {} },\n}\n';
  const { exitCode, files } = await generateUserAgentConfigs({ '.gemini/settings.json': original });

  expect(exitCode).toBe(1);
  expect(files['.gemini/settings.json']).toBe(original);
});
