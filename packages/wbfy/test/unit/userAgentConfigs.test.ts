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

test("turns off memory, attribution, and telemetry and sets the status line while keeping the developer's own Claude and Antigravity CLI settings", async () => {
  const { exitCode, files } = await generateUserAgentConfigs({
    '.claude/settings.json': '{\n  "effortLevel": "medium",\n  "attribution": { "commit": "keep me" }\n}\n',
    '.gemini/antigravity-cli/settings.json': '{\n  "trustedWorkspaces": ["/repo"],\n  "enableTelemetry": true\n}\n',
  });

  expect(exitCode).toBe(0);
  expect(JSON.parse(files['.claude/settings.json'] ?? '')).toEqual({
    attribution: { commit: '', pr: '', sessionUrl: false },
    autoMemoryEnabled: false,
    effortLevel: 'medium',
    statusLine: { type: 'command', command: expect.stringMatching(/^sh '.+\/\.claude\/statusline-command\.sh'$/u) },
  });
  expect(JSON.parse(files['.gemini/antigravity-cli/settings.json'] ?? '')).toEqual({
    enableTelemetry: false,
    statusLine: {
      type: 'command',
      command: expect.stringMatching(/^sh '.+\/\.gemini\/antigravity-cli\/statusline-command\.sh'$/u),
      enabled: true,
      stack_with_default: false,
    },
    trustedWorkspaces: ['/repo'],
  });
});

test('renders the Claude Code and Antigravity CLI status lines in the same format', async () => {
  const { files } = await generateUserAgentConfigs({ '.claude/statusline-command.sh': '' });
  const nowInSeconds = Math.floor(Date.now() / 1000);
  const tempRootPath = path.join(process.cwd(), '.tmp');
  await fs.promises.mkdir(tempRootPath, { recursive: true });
  const homePath = await fs.promises.mkdtemp(path.join(tempRootPath, 'status-line-home-'));
  const repoPath = path.join(homePath, 'repo');
  const render = async (payload: object): Promise<string> => {
    const spawned = Bun.spawn(['sh', '-c', files['.claude/statusline-command.sh'] ?? ''], {
      env: { ...Bun.env, HOME: homePath },
      stdin: new TextEncoder().encode(JSON.stringify(payload)),
      stdout: 'pipe',
    });
    return await new Response(spawned.stdout).text();
  };

  try {
    await Bun.spawn(['git', 'init', '-q', '-b', 'status-line', repoPath]).exited;
    expect(
      await render({
        cwd: repoPath,
        model: { display_name: 'Opus 5.5' },
        effort: { level: 'medium' },
        context_window: { used_percentage: 6 },
        rate_limits: {
          five_hour: { used_percentage: 2, resets_at: nowInSeconds + 2 * 3600 + 30 * 60 + 30 },
          seven_day: { used_percentage: 12, resets_at: nowInSeconds + 5 * 86_400 + 3600 + 30 },
        },
      })
    ).toBe('~/repo on git:status-line [Opus 5.5 · medium] [ctx 94%] [5h 98% 2h30m] [wk 88% 5d1h]');
    expect(
      await render({
        cwd: `${homePath}-sibling`,
        model: { display_name: 'Gemini 4 Argon (Medium)', effort: 'medium' },
        context_window: { used_percentage: 0 },
        quota: {
          '3p-5h': { remaining_fraction: 1, reset_in_seconds: 4 * 3600 + 59 * 60 + 30 },
          '3p-weekly': { remaining_fraction: 1, reset_in_seconds: 6 * 86_400 + 23 * 3600 + 30 },
          'gemini-5h': { remaining_fraction: 0.8453743, reset_in_seconds: 2 * 3600 + 54 * 60 + 30 },
          'gemini-weekly': { remaining_fraction: 0.88562787, reset_in_seconds: 5 * 86_400 + 3600 + 30 },
        },
      })
    ).toBe(
      `${homePath}-sibling [Gemini 4 Argon · medium] [ctx 100%] [5h 85% 2h54m] [wk 89% 5d1h] [3P 5h 100% 4h59m] [3P wk 100% 6d23h]`
    );
  } finally {
    await fs.promises.rm(homePath, { force: true, recursive: true });
  }
});

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

test('leaves a comment-only Claude settings file to the developer', async () => {
  const original = '// my claude settings\n';
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
