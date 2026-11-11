import { expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

test("turns off memory, attribution, and telemetry, sets the status line, and registers global skills idempotently while keeping the developer's own Claude and Antigravity CLI settings", async () => {
  const { exitCode, files, homePath } = await generateUserAgentConfigs(
    {
      '.claude/settings.json': '{\n  "effortLevel": "medium",\n  "attribution": { "commit": "keep me" }\n}\n',
      '.gemini/antigravity-cli/settings.json': '{\n  "trustedWorkspaces": ["/repo"],\n  "enableTelemetry": true\n}\n',
      '.gemini/config/skills.json':
        '{\n  "entries": [\n    { "path": "/personal-skills" },\n    { "path": "~/.agents/skills" }\n  ]\n}\n',
    },
    2
  );

  expect(exitCode).toBe(0);
  expect(JSON.parse(files['.claude/settings.json'] ?? '')).toEqual({
    attribution: { commit: '', pr: '', sessionUrl: false },
    autoMemoryEnabled: false,
    effortLevel: 'medium',
    statusLine: { type: 'command', command: `sh '${path.join(homePath, '.claude/statusline-command.sh')}'` },
  });
  expect(JSON.parse(files['.gemini/antigravity-cli/settings.json'] ?? '')).toEqual({
    enableTelemetry: false,
    statusLine: {
      type: 'command',
      command: `sh '${path.join(homePath, '.gemini/antigravity-cli/statusline-command.sh')}'`,
      enabled: true,
      stack_with_default: false,
    },
    trustedWorkspaces: ['/repo'],
  });
  expect(JSON.parse(files['.gemini/config/skills.json'] ?? '')).toEqual({
    entries: [{ path: '/personal-skills' }, { path: path.join(homePath, '.agents/skills') }],
  });
});

test('renders the Claude Code and Antigravity CLI status lines in the same format', async () => {
  const { files } = await generateUserAgentConfigs({ '.claude/statusline-command.sh': '' });
  const script = files['.claude/statusline-command.sh'] ?? '';
  const nowInSeconds = Math.floor(Date.now() / 1000);
  const tempRootPath = path.join(process.cwd(), '.tmp');
  await fs.promises.mkdir(tempRootPath, { recursive: true });
  const homePath = await fs.promises.mkdtemp(path.join(tempRootPath, 'status-line-home-'));
  const repoPath = path.join(homePath, 'repo');

  try {
    await Bun.spawn(['git', 'init', '-q', '-b', 'status-line', repoPath]).exited;
    expect(
      await renderStatusLine(script, homePath, {
        cwd: repoPath,
        model: { display_name: 'Opus 5.5' },
        effort: { level: 'medium' },
        context_window: { used_percentage: 6 },
        rate_limits: {
          five_hour: { used_percentage: 2, resets_at: nowInSeconds + 2 * 3600 + 30 * 60 + 30 },
          seven_day: { used_percentage: 12, resets_at: nowInSeconds + 5 * 86_400 + 3600 + 30 },
        },
      })
    ).toBe('~/repo on git:status-line [Opus 5.5 (medium)] [ctx 94%] [5h 98% (2h30m) | week 88% (5d1h)]');
    expect(
      await renderStatusLine(script, homePath, {
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
      `${homePath}-sibling [Gemini 4 Argon (medium)] [ctx 100%] [G: 5h 85% (2h54m) | week 89% (5d1h)] [3rd: 5h 100% (4h59m) | week 100% (6d23h)]`
    );
    expect(
      await renderStatusLine(script, homePath, {
        cwd: repoPath,
        rate_limits: { five_hour: { used_percentage: 2, resets_at: nowInSeconds + 2 * 3600 + 30 * 60 + 30 } },
      })
    ).toBe('~/repo on git:status-line [5h 98% (2h30m)]');
  } finally {
    await fs.promises.rm(homePath, { force: true, recursive: true });
  }
});

test('merges the memory setting into a commented Gemini settings file and global skills into a full-line commented Antigravity skills file', async () => {
  const { exitCode, files, homePath } = await generateUserAgentConfigs({
    '.gemini/config/skills.json':
      '// user skills config\n{\n  // personal skills\n  "entries": [\n    { "path": "/personal-skills" }\n  ]\n}\n',
    '.gemini/settings.json': '{\n  // chosen when signing in\n  "security": { "auth": {} }\n}\n',
  });

  expect(exitCode).toBe(0);
  const skillsContent = files['.gemini/config/skills.json'] ?? '';
  expect(JSON.parse(skillsContent.replaceAll(/^\s*\/\/.*$/gmu, ''))).toEqual({
    entries: [{ path: '/personal-skills' }, { path: path.join(homePath, '.agents/skills') }],
  });
  expect(skillsContent).toContain('// user skills config');
  expect(skillsContent).toContain('// personal skills');
  const content = files['.gemini/settings.json'] ?? '';
  expect(JSON.parse(content.replaceAll(/^\s*\/\/.*$/gmu, ''))).toEqual({
    experimental: { autoMemory: false },
    security: { auth: {} },
  });
  expect(content).toContain('// chosen when signing in');
});

test('leaves an Antigravity skills file with an inline or block comment to the developer', async () => {
  for (const original of [
    '{\n  "entries": [] // inline comment\n}\n',
    '{\n  /* block comment */\n  "entries": []\n}\n',
  ]) {
    const { exitCode, files } = await generateUserAgentConfigs({ '.gemini/config/skills.json': original });

    expect(exitCode).toBe(1);
    expect(files['.gemini/config/skills.json']).toBe(original);
  }
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

// Bun fixes os.homedir() at process start, so the command must run in a subprocess to observe the
// scratch HOME directory.
async function generateUserAgentConfigs(
  files: Record<string, string>,
  runs = 1
): Promise<{
  exitCode: number;
  files: Record<string, string>;
  homePath: string;
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
    let exitCode = 0;
    for (let i = 0; i < runs; i++) {
      const spawned = Bun.spawn(['bun', commandPath, 'generate-user-agent-configs'], {
        env: { ...Bun.env, HOME: homePath },
        stderr: 'pipe',
        stdout: 'pipe',
      });
      exitCode ||= await spawned.exited;
    }
    const generatedFiles: Record<string, string> = {};
    for (const relativePath of Object.keys(files)) {
      generatedFiles[relativePath] = await fs.promises.readFile(path.join(homePath, relativePath), 'utf8');
    }
    return { exitCode, files: generatedFiles, homePath };
  } finally {
    await fs.promises.rm(homePath, { force: true, recursive: true });
  }
}

async function renderStatusLine(script: string, homePath: string, payload: object): Promise<string> {
  const spawned = Bun.spawn(['sh', '-c', script], {
    env: { ...Bun.env, HOME: homePath },
    stdin: new TextEncoder().encode(JSON.stringify(payload)),
    stdout: 'pipe',
  });
  return await new Response(spawned.stdout).text();
}
